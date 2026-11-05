// The preprocessor: walks main.ass, follows #[include]s depth-first (each file at most
// once), evaluates #[if] blocks and injects variables, producing an ordered list of
// output lines that remember which source file and line they came from.
//
// It tracks AngelScript lexical state (code / comment / string / heredoc) so that:
//   * in comments, only #[name] value injection happens; a commented-out #[include]
//     or #[if] stays inert, like you'd expect
//   * in strings, #[name] and #[if]/#[else]/#[endif] work, $name is left alone
//   * in code, everything works, and $name becomes a ready-to-use literal

import fs from 'node:fs';
import path from 'node:path';
import { AngelSpaceError, c, type Diagnostic, type Loc, type Logger } from './log.ts';
import { evaluate } from './expr.ts';
import { toLiteral, toRaw, v, type Value } from './values.ts';
import type { Config } from './config.ts';

export const SOURCE_EXT = '.ass';

export interface SourceFile { idx: number; abs: string; rel: string; text: string; lines: number; }
export interface Reference { from: number; line: number; }

export type Item =
  | { kind: 'line'; text: string; f: number; l: number }
  | { kind: 'header'; f: number; continued: boolean };

export interface CompileResult {
  items: Item[];
  files: SourceFile[];
  /** files in the order their content was first emitted (dependencies first, main last) */
  order: number[];
  referencedBy: Map<number, Reference[]>;
  mainIdx: number;
  directives: number;
  injections: number;
  /** warnings and notes with locations (errors go in `error`) */
  diagnostics: Diagnostic[];
  /** per file: 1-based source lines that sat in a false #[if] branch */
  inactive: Map<number, number[]>;
  /** set when compilation stopped; everything above is what was gathered up to that point */
  error?: AngelSpaceError;
}

export interface CompileOptions {
  /** Supplies file contents (e.g. unsaved editor buffers); return undefined to read from disk. */
  readFile?: (abs: string) => string | undefined;
}

/** Resolve an #[include] path the way the compiler does. Pure; safe to call from editors. */
export function resolveInclude(spec: string, fromAbs: string, srcRoot: string):
  { abs: string; note: string } | { error: string; tried: string[] } {
  const rooted = spec.startsWith('/');
  const base = rooted ? srcRoot : path.dirname(fromAbs);
  const abs = path.resolve(base, rooted ? spec.replace(/^\/+/, '') : spec);
  const inside = path.relative(srcRoot, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return { error: `include "${spec}" points outside the source folder`, tried: [] };
  const candidates: [string, string][] = [[abs, '']];
  if (abs.endsWith('.as')) candidates.push([abs + 's', '.as → .ass']);
  else if (!path.extname(abs)) candidates.push([abs + SOURCE_EXT, `+${SOURCE_EXT}`]);
  for (const [p, note] of candidates) if (fs.existsSync(p) && fs.statSync(p).isFile()) return { abs: p, note };
  const tried = candidates.map(([p]) => path.relative(srcRoot, p).split(path.sep).join('/'));
  return { error: `include "${spec}" not found (tried ${tried.join(', ')})`, tried };
}

type LexState = 'code' | 'line' | 'block' | 'dq' | 'sq' | 'heredoc';
interface Frame { active: boolean; parent: boolean; taken: boolean; sawElse: boolean; loc: Loc; kw: string; }

const CONTROL = new Set(['if', 'ifn', 'elif', 'elifn', 'else', 'endif']);
const STATEMENT = new Set(['include', 'error', 'warn', 'info']);
const IDENT = /[A-Za-z_]\w*/y;

export function compile(cfg: Config, vars: Map<string, Value>, log: Logger, opts: CompileOptions = {}): CompileResult {
  return new Compiler(cfg, vars, log, opts).run();
}

class Compiler {
  cfg: Config; vars: Map<string, Value>; log: Logger;
  files: SourceFile[] = [];
  byKey = new Map<string, number>();
  status = new Map<number, 'active' | 'done'>();
  referencedBy = new Map<number, Reference[]>();
  items: Item[] = [];
  order: number[] = [];
  chain: { f: number; line: number }[] = [];
  directives = 0;
  injections = 0;
  diagnostics: Diagnostic[] = [];
  inactive = new Map<number, number[]>();
  readFile: CompileOptions['readFile'];

  // current output line being assembled
  buf = '';
  origin: { f: number; l: number } | null = null;
  lastFile = -1;
  headed = new Set<number>();

  constructor(cfg: Config, vars: Map<string, Value>, log: Logger, opts: CompileOptions) {
    this.cfg = cfg; this.vars = vars; this.log = log; this.readFile = opts.readFile;
  }

  run(): CompileResult {
    const mainIdx = this.register(this.cfg.mainAbs);
    let error: AngelSpaceError | undefined;
    try {
      this.log.verbose(`main ${c.bold(this.files[mainIdx]!.rel)}`);
      this.process(mainIdx, 0);
      if (this.buf !== '') this.commit();
    } catch (e) {
      if (!(e instanceof AngelSpaceError)) throw e;
      error = e;
    }
    return {
      items: this.items, files: this.files, order: this.order, referencedBy: this.referencedBy,
      mainIdx, directives: this.directives, injections: this.injections,
      diagnostics: this.diagnostics, inactive: this.inactive, error,
    };
  }

  note(severity: Diagnostic['severity'], message: string, loc: Loc) {
    this.diagnostics.push({ severity, message, loc });
  }

  // ---------------------------------------------------------------- output

  emit(s: string, f: number, l: number) {
    for (const ch of s) {
      if (this.origin === null) this.origin = { f, l };
      if (ch === '\n') this.commit();
      else this.buf += ch;
    }
  }

  commit() {
    const o = this.origin ?? { f: -1, l: 0 };
    // A header goes in front of the first line a file contributes, and again
    // ("continued") if an include in the middle of a file interrupted it.
    if (o.f !== this.lastFile && o.f >= 0) {
      this.items.push({ kind: 'header', f: o.f, continued: this.headed.has(o.f) });
      if (!this.headed.has(o.f)) { this.headed.add(o.f); this.order.push(o.f); }
      this.lastFile = o.f;
    }
    this.items.push({ kind: 'line', text: this.buf, f: o.f, l: o.l });
    this.buf = '';
    this.origin = null;
  }

  /** Drop the last n characters of the line being assembled (indentation before a directive). */
  unemit(n: number) {
    if (n <= 0) return;
    this.buf = this.buf.slice(0, Math.max(0, this.buf.length - n));
    if (this.buf === '') this.origin = null;
  }

  // ---------------------------------------------------------------- files

  key(abs: string) {
    let p = abs;
    try { p = fs.realpathSync.native(abs); } catch { /* resolved before, exists */ }
    return process.platform === 'win32' ? p.toLowerCase() : p;
  }

  register(abs: string): number {
    const k = this.key(abs);
    const existing = this.byKey.get(k);
    if (existing !== undefined) return existing;
    const raw = this.readFile?.(abs) ?? fs.readFileSync(abs, 'utf8');
    const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const rel = path.relative(this.cfg.src, abs).split(path.sep).join('/');
    const idx = this.files.length;
    this.files.push({ idx, abs, rel, text, lines: text.split('\n').length });
    this.byKey.set(k, idx);
    this.referencedBy.set(idx, []);
    return idx;
  }

  resolve(spec: string, from: SourceFile, loc: Loc): { abs: string; note: string } {
    const r = resolveInclude(spec, from.abs, this.cfg.src);
    if ('error' in r) throw new AngelSpaceError(r.error, loc);
    return r;
  }

  lookup(name: string, file: SourceFile, line: number): Value | undefined {
    if (name === '__FILE__') return v.string(file.rel);
    if (name === '__LINE__') return v.number(line);
    return this.vars.get(name);
  }

  chainText() {
    return [...this.chain].reverse().map((e) => `${this.files[e.f]!.rel}:${e.line}`);
  }

  // ---------------------------------------------------------------- the walk

  process(idx: number, depth: number, via = '') {
    const file = this.files[idx]!;
    const src = file.text, n = src.length;
    const L = this.log.at(depth);
    this.status.set(idx, 'active');
    const t0 = performance.now();
    L.verbose(`${c.cyan('▸')} ${c.bold(file.rel)} ${c.gray(`(${file.lines} lines)${via ? ' ← ' + via : ''}`)}`);

    let i = 0, line = 1, lineStart = 0;
    let onLine = 0; // chars emitted since this source line began; -1 = unknown (inline include)
    let state: LexState = 'code';
    const conds: Frame[] = [];
    const inactiveLines: number[] = [];
    this.inactive.set(idx, inactiveLines);
    const active = () => conds.length === 0 || conds[conds.length - 1]!.active;
    const out = (s: string) => {
      if (!active()) return;
      this.emit(s, idx, line);
      if (onLine >= 0) onLine += s.length;
    };
    const loc = (at: number): Loc => ({ rel: file.rel, abs: file.abs, line, col: at - lineStart + 1, text: src, chain: this.chainText() });
    const fail = (msg: string, at: number): never => { throw new AngelSpaceError(msg, loc(at)); };
    const where = () => c.gray(`${file.rel}:${line}`);

    while (i < n) {
      const ch = src[i]!;

      if (ch === '\n') {
        if (state === 'line') state = 'code';
        else if (state === 'dq' || state === 'sq') {
          if (active()) {
            L.warn(`${where()} string literal runs past the end of the line`);
            this.note('warning', 'string literal runs past the end of the line', loc(i));
          }
          state = 'code';
        }
        if (!active()) inactiveLines.push(line);
        out('\n');
        i++; line++; lineStart = i; onLine = 0;
        continue;
      }

      const inComment = state === 'line' || state === 'block';
      const inString = state === 'dq' || state === 'sq' || state === 'heredoc';

      // \#[ is a literal "#[" (outside comments, where nothing needs escaping anyway)
      if (ch === '\\' && src.startsWith('#[', i + 1) && !inComment) { out('#['); i += 3; continue; }

      if (ch === '#' && src[i + 1] === '[') {
        const end = directiveEnd(src, i + 2);
        if (end < 0) {
          if (inComment) { out(ch); i++; continue; }
          fail('unterminated #[ directive (no closing ] on this line)', i);
        }
        const body = src.slice(i + 2, end).trim();
        const kw = /^[A-Za-z_]\w*/.exec(body)?.[0] ?? '';
        const rest = body.slice(kw.length).trim();
        const isControl = CONTROL.has(kw);
        const isStatement = STATEMENT.has(kw);
        const isValue = !isControl && !isStatement && kw !== '' && rest === '';
        const after = end + 1;

        if (inComment) {
          // Only value injection runs in comments, and an unknown name is left as-is.
          const val = isValue && active() ? this.lookup(kw, file, line) : undefined;
          out(val ? toRaw(val) : src.slice(i, after));
          i = after;
          continue;
        }
        if (!isControl && !isStatement && !isValue) fail(`unknown directive #[${body}]`, i);
        if (isStatement && inString) fail(`#[${kw}] can't be used inside a string literal`, i);

        this.directives++;
        // A control/statement directive alone on its line takes the whole line with it.
        const nl = src.indexOf('\n', after);
        const eol = nl < 0 ? n : nl;
        const wholeLine = (isControl || isStatement) && src.slice(lineStart, i).trim() === '' && src.slice(after, eol).trim() === '';
        if (wholeLine && active() && onLine > 0) this.unemit(onLine);

        if (isControl) {
          this.control(kw, rest, conds, loc(i), L, file);
        } else if (isStatement) {
          if (active()) {
            const arg = stringArg(rest);
            if (arg === null) fail(`#[${kw}] expects a quoted string, e.g. #[${kw} "${kw === 'include' ? '/sdk/bones.ass' : 'message'}"]`, i);
            if (kw === 'include') {
              this.include(arg!, file, loc(i), depth);
              if (!wholeLine) onLine = -1;
            } else if (kw === 'error') {
              fail(arg!, i);
            } else {
              (kw === 'warn' ? L.warn : L.info)(`${where()} ${arg}`);
              this.note(kw === 'warn' ? 'warning' : 'info', arg!, loc(i));
            }
          }
        } else if (active()) {
          const val = this.lookup(kw, file, line);
          if (val === undefined) fail(`undefined variable '${kw}'`, i);
          out(toRaw(val!));
          this.injections++;
          L.debug(`${where()} #[${kw}] → ${toRaw(val!)}`);
        }

        i = after;
        if (wholeLine) {
          // The directive owned the line: swallow its newline so no blank line is left behind.
          if (nl >= 0) { i = nl + 1; line++; lineStart = i; onLine = 0; } else i = n;
        }
        continue;
      }

      if (ch === '$' && state === 'code') {
        if (src[i + 1] === '$') { out('$'); i += 2; continue; }
        IDENT.lastIndex = i + 1;
        const m = IDENT.exec(src);
        if (!m) {
          if (active()) fail(`stray '$' (use $name to inject a variable, or $$ for a literal $)`, i);
          i++; continue;
        }
        if (active()) {
          const val = this.lookup(m[0], file, line);
          if (val === undefined) fail(`undefined variable '${m[0]}'`, i);
          const lit = toLiteral(val!);
          out(lit);
          this.injections++;
          L.debug(`${where()} $${m[0]} → ${lit}`);
        }
        i += 1 + m[0].length;
        continue;
      }

      switch (state) {
        case 'code':
          if (ch === '/' && src[i + 1] === '/') { state = 'line'; out('//'); i += 2; continue; }
          if (ch === '/' && src[i + 1] === '*') { state = 'block'; out('/*'); i += 2; continue; }
          if (src.startsWith('"""', i)) { state = 'heredoc'; out('"""'); i += 3; continue; }
          if (ch === '"') state = 'dq';
          else if (ch === "'") state = 'sq';
          break;
        case 'block':
          if (ch === '*' && src[i + 1] === '/') { state = 'code'; out('*/'); i += 2; continue; }
          break;
        case 'heredoc':
          if (src.startsWith('"""', i)) { state = 'code'; out('"""'); i += 3; continue; }
          break;
        case 'dq':
        case 'sq':
          if (ch === '\\' && i + 1 < n && src[i + 1] !== '\n') { out(src.slice(i, i + 2)); i += 2; continue; }
          if ((state === 'dq' && ch === '"') || (state === 'sq' && ch === "'")) { out(ch); state = 'code'; i++; continue; }
          break;
        case 'line':
          break;
      }
      out(ch);
      i++;
    }

    if (conds.length) {
      const open = conds[conds.length - 1]!;
      throw new AngelSpaceError(`#[${open.kw}] is never closed (missing #[endif] before end of file)`, open.loc);
    }
    if (state === 'block' || state === 'heredoc') {
      const what = `ends inside an unterminated ${state === 'block' ? 'block comment' : 'heredoc string'}`;
      L.warn(`${file.rel} ${what}`);
      this.note('warning', `file ${what}`, loc(i));
    }
    // Never let the next file's first line fuse onto this file's last one.
    if (this.buf !== '') this.commit();

    this.status.set(idx, 'done');
    L.debug(`${c.cyan('◂')} ${file.rel} ${c.gray(`${(performance.now() - t0).toFixed(1)}ms`)}`);
  }

  control(kw: string, rest: string, conds: Frame[], loc: Loc, L: ReturnType<Logger['at']>, file: SourceFile) {
    const top = conds[conds.length - 1];
    const where = c.gray(`${loc.rel}:${loc.line}`);
    const test = (negate: boolean) => {
      if (!rest) throw new AngelSpaceError(`#[${kw}] needs a condition`, loc);
      let r: boolean;
      try { r = evaluate(rest, (name) => this.lookup(name, file, loc.line)); }
      catch (e) { throw new AngelSpaceError((e as Error).message, loc); }
      return negate ? !r : r;
    };
    const show = (r: boolean | null) =>
      r === null ? c.gray('skipped (inside an inactive block)') : r ? c.green('true') : c.yellow('false');

    switch (kw) {
      case 'if':
      case 'ifn': {
        const parent = conds.length === 0 || top!.active;
        const r = parent ? test(kw === 'ifn') : false;
        conds.push({ active: parent && r, parent, taken: parent && r, sawElse: false, loc, kw });
        L.verbose(`${where} #[${kw} ${rest}] → ${show(parent ? r : null)}`);
        return;
      }
      case 'elif':
      case 'elifn': {
        if (!top) throw new AngelSpaceError(`#[${kw}] without a matching #[if]`, loc);
        if (top.sawElse) throw new AngelSpaceError(`#[${kw}] after #[else]`, loc);
        if (!top.parent || top.taken) {
          top.active = false;
          L.verbose(`${where} #[${kw} ${rest}] → ${top.parent ? c.gray('skipped (an earlier branch was taken)') : show(null)}`);
        } else {
          const r = test(kw === 'elifn');
          top.active = r; top.taken = r;
          L.verbose(`${where} #[${kw} ${rest}] → ${show(r)}`);
        }
        return;
      }
      case 'else':
        if (rest) throw new AngelSpaceError(`#[else] takes no condition (did you mean #[elif ${rest}]?)`, loc);
        if (!top) throw new AngelSpaceError(`#[else] without a matching #[if]`, loc);
        if (top.sawElse) throw new AngelSpaceError(`duplicate #[else]`, loc);
        top.sawElse = true;
        top.active = top.parent && !top.taken;
        top.taken = true;
        L.debug(`${where} #[else] → ${top.parent ? show(top.active) : show(null)}`);
        return;
      case 'endif':
        if (rest) throw new AngelSpaceError(`#[endif] takes no argument`, loc);
        if (!top) throw new AngelSpaceError(`#[endif] without a matching #[if]`, loc);
        conds.pop();
        L.debug(`${where} #[endif]`);
        return;
    }
  }

  include(spec: string, from: SourceFile, loc: Loc, depth: number) {
    const { abs, note } = this.resolve(spec, from, loc);
    const idx = this.register(abs);
    const target = this.files[idx]!;
    this.referencedBy.get(idx)!.push({ from: from.idx, line: loc.line });
    const L = this.log.at(depth + 1);
    const label = `${c.gray(`${from.rel}:${loc.line}`)} include "${spec}" → ${target.rel}${note ? c.gray(` (${note})`) : ''}`;
    const st = this.status.get(idx);
    if (st === 'done') { L.verbose(`${label} ${c.gray('already included, skipped')}`); return; }
    if (st === 'active') {
      L.verbose(`${label} ${c.gray('circular (still being processed), skipped')}`);
      return;
    }
    this.chain.push({ f: from.idx, line: loc.line });
    this.process(idx, depth + 1, `${from.rel}:${loc.line} "${spec}"${note ? ` (${note})` : ''}`);
    this.chain.pop();
  }
}

/** Index of the `]` closing a directive whose body starts at `from`, honoring quotes; -1 if none on this line. */
function directiveEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let k = from; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\n') return -1;
    if (q) {
      if (ch === '\\') k++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ']') return k;
  }
  return -1;
}

function stringArg(rest: string): string | null {
  if (/^"(?:[^"\\]|\\.)*"$/.test(rest)) return JSON.parse(rest) as string;
  if (/^'[^']*'$/.test(rest)) return rest.slice(1, -1);
  return null;
}
