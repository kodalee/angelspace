// Turns a CompileResult into the final .as text: watermark, per-file headers,
// line endings, plus the line map used by `npm run where`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AngelSpaceError } from './log.ts';
import { toRaw, v, type Value } from './values.ts';
import type { CompileResult } from './compiler.ts';
import type { Config } from './config.ts';

export interface LineMap {
  version: 1;
  output: string;
  sources: string[];
  /** index = output line - 1; [source index, source line] or null for generated lines */
  lines: ([number, number] | null)[];
}

export interface Assembled { text: string; map: LineMap; lineCount: number; buildHash: string; outputName: string; }

/** Replace #[name] in a config template (output file name, watermark lines). */
export function renderTemplate(tpl: string, vars: Map<string, Value>, what: string): string {
  return tpl.replace(/#\[\s*([A-Za-z_]\w*)\s*\]/g, (_, name: string) => {
    const val = vars.get(name);
    if (val === undefined) throw new AngelSpaceError(`${what} uses undefined variable '${name}'`);
    return toRaw(val);
  });
}

export function assemble(cfg: Config, res: CompileResult, vars: Map<string, Value>, opts: { watermark: boolean; headers: boolean }): Assembled {
  const rel = (f: number) => res.files[f]!.rel;
  const body: { text: string; at: [number, number] | null }[] = [];

  for (const item of res.items) {
    if (item.kind === 'line') { body.push({ text: item.text, at: item.f >= 0 ? [item.f, item.l] : null }); continue; }
    if (!opts.headers) continue;
    // Breathing room between files, without stacking blank lines.
    if (body.length && body[body.length - 1]!.text.trim() !== '') body.push({ text: '', at: null });
    for (const text of headerLines(item.f, item.continued)) body.push({ text, at: null });
  }

  function headerLines(f: number, continued: boolean): string[] {
    const name = rel(f) + (f === res.mainIdx ? ' (main)' : '');
    if (continued) return [`// ${rel(f)} (continued)`];
    const by = (res.referencedBy.get(f) ?? []).map((r) => `${rel(r.from)}:${r.line}`);
    if (!by.length) return [`// ${name}`];
    if (by.length === 1) return [`// ${name} referenced by ${by[0]}`];
    return [`// ${name} referenced by:`, ...by.map((b) => `//   ${b}`)];
  }

  const eol = cfg.output.lineEndings === 'crlf' ? '\r\n' : '\n';
  const bodyText = body.map((b) => b.text).join(eol) + eol;
  const buildHash = crypto.createHash('sha256').update(bodyText).digest('hex').slice(0, 12);
  const outputName = renderTemplate(cfg.output.file, vars, `output.file`);

  const wm: string[] = [];
  if (opts.watermark && cfg.output.watermark.enabled) {
    const post = new Map(vars);
    post.set('fileCount', v.number(res.order.length));
    post.set('lineCount', v.number(body.length));
    post.set('buildHash', v.string(buildHash));
    post.set('outputFile', v.string(outputName));
    for (const tpl of cfg.output.watermark.lines) wm.push(`// ${renderTemplate(tpl, post, 'watermark')}`);
    wm.push('');
  }

  const text = (wm.length ? wm.join(eol) + eol : '') + bodyText;
  const map: LineMap = {
    version: 1,
    output: outputName,
    sources: res.files.map((f) => path.relative(cfg.root, f.abs).split(path.sep).join('/')),
    lines: [...wm.map(() => null), ...body.map((b) => b.at)],
  };
  return { text, map, lineCount: body.length, buildHash, outputName };
}

export const mapPath = (outFile: string) => outFile + '.map.json';

export function readMap(outFile: string): LineMap {
  const p = mapPath(outFile);
  if (!fs.existsSync(p)) throw new AngelSpaceError(`no line map at ${p} (compile first, with output.lineMap enabled)`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as LineMap;
}

/** Copy into the Angel scripts folder, refusing to clobber a script AngelSpace didn't write. */
export function install(outFile: string, dir: string, force: boolean): string {
  const dest = path.join(dir, path.basename(outFile));
  if (path.resolve(dest) === path.resolve(outFile)) return dest;
  if (fs.existsSync(dest) && !force) {
    const head = fs.readFileSync(dest, 'utf8').slice(0, 512);
    if (!/AngelSpace/.test(head.split(/\r?\n/)[0] ?? '')) {
      throw new AngelSpaceError(`refusing to overwrite ${dest}: it wasn't produced by AngelSpace (pass --force or set install.overwrite: true)`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(outFile, dest);
  return dest;
}
