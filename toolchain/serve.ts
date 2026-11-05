// `serve` (node toolchain/cli.ts serve): the toolchain's editor interface. Editors (the AngelSpace VS Code
// extension) start this process from the repo's toolchain/ folder and ask it to
// analyze, compile, resolve includes and map lines. Editors never compile anything
// themselves, so what you see in the editor is exactly what `npm run build` does.
//
// Wire format: one JSON object per line on stdin/stdout.
//   request   {"id": 1, "method": "analyze", "params": {...}}
//   response  {"id": 1, "result": {...}}   or   {"id": 1, "error": {"message": "..."}}
// stdout carries nothing else; stray output goes to stderr.

import path from 'node:path';
import readline from 'node:readline';
import { AngelSpaceError, createLogger, isLevel, type Diagnostic, type Level } from './log.ts';
import { loadConfig } from './config.ts';
import { ANGELSPACE_VERSION, BUILTIN_DOCS, POST_BUILD_DOCS } from './builtins.ts';
import { resolveInclude } from './compiler.ts';
import { readMap, renderTemplate } from './output.ts';
import { buildProject, type BuildOutput } from './project.ts';
import { toLiteral, toRaw } from './values.ts';

/** Bumped when requests or results change incompatibly. */
export const PROTOCOL = 1;

export interface VarInfo { name: string; type: string; raw: string; literal: string; origin: string; doc?: string; }
export interface WireLoc { rel: string; abs?: string; line: number; col: number; lineText?: string; chain?: string[]; }
export interface WireDiagnostic { severity: Diagnostic['severity']; message: string; loc?: WireLoc; }

export interface Snapshot {
  configPath: string;
  project?: {
    name: string; target: string; root: string; src: string; main: string; mainAbs: string;
    outputDir: string; outFile?: string; lineMap: boolean; defines: string[]; vars: VarInfo[];
  };
  result?: {
    files: { idx: number; abs: string; rel: string }[];
    order: number[]; mainIdx: number;
    referencedBy: Record<number, { from: number; line: number }[]>;
    inactive: Record<number, number[]>;
    directives: number; injections: number;
  };
  diagnostics: WireDiagnostic[];
  error?: { message: string; loc?: WireLoc };
  ms: number;
}

export interface CompileReport extends Snapshot {
  outFile?: string; installedTo?: string; lineCount?: number; buildHash?: string;
  /** the build log, one entry per line (ANSI colors included) */
  log: string[];
}

type Overrides = [string, string][];

interface Methods {
  hello(): { protocol: number; version: string; configPath: string; root: string; postBuildVars: Record<string, string> };
  analyze(p: { overrides?: Overrides; overlays?: Record<string, string> }): Snapshot;
  compile(p: { overrides?: Overrides; install?: boolean; force?: boolean; logLevel?: string }): CompileReport;
  resolveInclude(p: { spec: string; from: string }): { abs: string; note: string } | { error: string };
  where(p: { line: number; outFile?: string; overrides?: Overrides }): { abs: string; rel: string; line: number } | { generated: true } | { pastEnd: true; lines: number };
  shutdown(): null;
}

export function serve(configPath: string): void {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const srcDir = () => loadConfig(configPath, createLogger('silent')).src;

  const methods: Methods = {
    hello: () => ({ protocol: PROTOCOL, version: ANGELSPACE_VERSION, configPath, root: path.dirname(configPath), postBuildVars: POST_BUILD_DOCS }),

    analyze: ({ overrides = [], overlays = {} }) => {
      const byKey = new Map(Object.entries(overlays).map(([k, text]) => [norm(k), text]));
      const out = buildProject({ configPath, log: createLogger('silent'), overrides, readFile: (abs) => byKey.get(norm(abs)), write: false });
      return snapshot(configPath, out);
    },

    compile: ({ overrides = [], install = false, force = false, logLevel }) => {
      const lines: string[] = [];
      let level: Level = 'verbose';
      if (logLevel && isLevel(logLevel)) level = logLevel;
      else try { level = loadConfig(configPath, createLogger('silent')).log.level; } catch { /* the build reports it */ }
      const log = createLogger(level, (line) => { lines.push(line); });
      const out = buildProject({ configPath, log, overrides, write: true, install, force });
      if (out.error) log.error(out.error.format());
      return {
        ...snapshot(configPath, out), log: lines,
        outFile: out.outFile, installedTo: out.installedTo, lineCount: out.assembled?.lineCount, buildHash: out.assembled?.buildHash,
      };
    },

    resolveInclude: ({ spec, from }) => {
      const r = resolveInclude(spec, from, srcDir());
      return 'error' in r ? { error: r.error } : r;
    },

    where: ({ line, outFile, overrides = [] }) => {
      let file = outFile;
      if (!file) {
        const out = buildProject({ configPath, log: createLogger('silent'), overrides, write: false });
        file = out.outFile;
        if (!file) throw out.error ?? new AngelSpaceError('the output file name could not be worked out');
      }
      const map = readMap(file);
      const hit = map.lines[line - 1];
      if (hit === undefined) return { pastEnd: true, lines: map.lines.length };
      if (hit === null) return { generated: true };
      const rel = map.sources[hit[0]]!;
      return { abs: path.resolve(path.dirname(configPath), rel), rel, line: hit[1] };
    },

    shutdown: () => { setImmediate(() => process.exit(0)); return null; },
  };

  // Keep stdout for the protocol alone.
  console.log = console.info = console.warn = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (text) => {
    if (!text.trim()) return;
    let req: { id?: unknown; method?: string; params?: unknown };
    try { req = JSON.parse(text); } catch { send({ id: null, error: { message: 'malformed JSON request' } }); return; }
    const fn = methods[req.method as keyof Methods] as ((p: unknown) => unknown) | undefined;
    if (!fn) { send({ id: req.id, error: { message: `unknown method '${req.method}'` } }); return; }
    try { send({ id: req.id, result: fn(req.params ?? {}) }); }
    catch (e) { send({ id: req.id, error: { message: (e as Error)?.message ?? String(e) } }); }
  });
  rl.on('close', () => process.exit(0));
}

function wireLoc(l: Diagnostic['loc']): WireLoc | undefined {
  if (!l) return undefined;
  return { rel: l.rel, abs: l.abs, line: l.line, col: l.col, lineText: l.text?.split(/\r?\n/)[l.line - 1], chain: l.chain };
}

function snapshot(configPath: string, out: BuildOutput): Snapshot {
  const s: Snapshot = {
    configPath,
    diagnostics: out.diagnostics.map((d) => ({ severity: d.severity, message: d.message, loc: wireLoc(d.loc) })),
    ms: out.ms,
  };
  if (out.error) s.error = { message: out.error.message, loc: wireLoc(out.error.loc) };
  if (out.project) {
    const { cfg, vars, origin } = out.project;
    let outFile = out.outFile;
    if (!outFile) try { outFile = path.join(cfg.output.dir, renderTemplate(cfg.output.file, vars, 'output.file')); } catch { /* reported by the build */ }
    s.project = {
      name: cfg.name, target: cfg.target, root: cfg.root, src: cfg.src, main: cfg.main, mainAbs: cfg.mainAbs,
      outputDir: cfg.output.dir, outFile, lineMap: cfg.output.lineMap, defines: [...cfg.defines.keys()],
      vars: [...vars].map(([name, val]) => ({ name, type: val.type, raw: toRaw(val), literal: toLiteral(val), origin: origin.get(name) ?? 'builtin', doc: BUILTIN_DOCS[name] })),
    };
  }
  if (out.result) {
    const r = out.result;
    s.result = {
      files: r.files.map((f) => ({ idx: f.idx, abs: f.abs, rel: f.rel })),
      order: r.order, mainIdx: r.mainIdx,
      referencedBy: Object.fromEntries(r.referencedBy),
      inactive: Object.fromEntries(r.inactive),
      directives: r.directives, injections: r.injections,
    };
  }
  return s;
}
