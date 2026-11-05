// Library entry point: load a project and build it. Shared by the CLI and the editor
// extension. Problems in the sources come back as diagnostics instead of exceptions.

import fs from 'node:fs';
import path from 'node:path';
import { AngelSpaceError, c, type Diagnostic, type Logger } from './log.ts';
import { loadConfig, NAME, RESERVED, type Config } from './config.ts';
import { ANGELSPACE_VERSION, builtinVars } from './builtins.ts';
import { compile, SOURCE_EXT, type CompileResult } from './compiler.ts';
import { assemble, install, mapPath, type Assembled } from './output.ts';
import { fromCli, toLiteral, type Value } from './values.ts';

export interface Project {
  cfg: Config;
  vars: Map<string, Value>;
  /** where each variable came from: builtin | config | cli */
  origin: Map<string, string>;
}

/** Load config and resolve variables. `overrides` are `-D`-style name=value pairs. */
export function loadProject(configPath: string, log: Logger, overrides: [string, string][] = []): Project {
  const cfg = loadConfig(configPath, log);
  const vars = builtinVars(cfg, new Date());
  const origin = new Map<string, string>([...vars.keys()].map((k) => [k, 'builtin']));
  for (const [k, val] of cfg.defines) {
    if (vars.has(k)) log.warn(`define '${k}' overrides a built-in variable`);
    vars.set(k, val); origin.set(k, 'config');
  }
  for (const [k, text] of overrides) {
    if (!NAME.test(k) || RESERVED.has(k)) throw new AngelSpaceError(`-D ${k}: not a valid variable name`);
    const val = fromCli(text);
    log.verbose(`-D ${k} = ${toLiteral(val)}${vars.has(k) ? c.gray(` (was ${toLiteral(vars.get(k)!)})`) : ''}`);
    vars.set(k, val); origin.set(k, 'cli');
  }
  return { cfg, vars, origin };
}

export interface BuildOptions {
  configPath: string;
  log: Logger;
  overrides?: [string, string][];
  /** unsaved editor contents; undefined = read from disk */
  readFile?: (abs: string) => string | undefined;
  /** write dist/ files (false = analyze only) */
  write?: boolean;
  watermark?: boolean;
  headers?: boolean;
  install?: boolean;
  force?: boolean;
}

export interface BuildOutput {
  project?: Project;
  result?: CompileResult;
  assembled?: Assembled;
  outFile?: string;
  installedTo?: string;
  diagnostics: Diagnostic[];
  /** the error that stopped the build, if any (also present in diagnostics) */
  error?: AngelSpaceError;
  ms: number;
}

export function buildProject(o: BuildOptions): BuildOutput {
  const t0 = performance.now();
  const log = o.log;
  const diagnostics: Diagnostic[] = [];
  const done = (out: Omit<BuildOutput, 'diagnostics' | 'ms'>): BuildOutput => {
    if (out.error) diagnostics.unshift({ severity: 'error', message: out.error.message, loc: out.error.loc });
    return { ...out, diagnostics, ms: performance.now() - t0 };
  };

  let project: Project;
  try { project = loadProject(o.configPath, log, o.overrides); }
  catch (e) {
    if (e instanceof AngelSpaceError) {
      e.loc ??= { rel: path.basename(o.configPath), abs: o.configPath, line: 1, col: 1 };
      return done({ error: e });
    }
    throw e;
  }
  const { cfg, vars } = project;

  log.info(`${c.bold('angelspace')} ${ANGELSPACE_VERSION} · ${c.bold(cfg.name)}${cfg.target ? c.gray(` → ${cfg.target}`) : ''}`);
  for (const [k, val] of vars) log.debug(`var ${k} = ${toLiteral(val)}`);
  if (log.enabled('verbose')) {
    const user = [...cfg.defines.keys(), ...(o.overrides ?? []).map(([k]) => k)];
    log.verbose(`variables: ${[...new Set(user)].map((k) => `${k}=${toLiteral(vars.get(k)!)}`).join(', ') || c.gray('(none)')}`);
  }

  const result = compile(cfg, vars, log, { readFile: o.readFile });
  diagnostics.push(...result.diagnostics);
  if (result.error) return done({ project, result, error: result.error });

  // Sources nothing reached are usually a forgotten #[include].
  const reached = new Set(result.files.map((f) => norm(f.abs)));
  const stray: string[] = [], wrongExt: string[] = [];
  for (const f of walk(cfg.src)) {
    const rel = path.relative(cfg.src, f).split(path.sep).join('/');
    if (f.endsWith(SOURCE_EXT) && !reached.has(norm(f))) {
      stray.push(rel);
      diagnostics.push({ severity: 'warning', message: `never included from ${cfg.main}, so it isn't part of the build`, loc: { rel, abs: f, line: 1, col: 1 } });
    } else if (f.endsWith('.as')) wrongExt.push(rel);
  }
  if (stray.length) log.warn(`${stray.length} source file(s) never included: ${stray.join(', ')}`);
  if (wrongExt.length) log.warn(`.as file(s) in src/ are ignored (sources use ${SOURCE_EXT}): ${wrongExt.join(', ')}`);

  let assembled: Assembled;
  try {
    assembled = assemble(cfg, result, vars, { watermark: o.watermark ?? true, headers: (o.headers ?? true) && cfg.output.fileHeaders });
  } catch (e) {
    if (e instanceof AngelSpaceError) return done({ project, result, error: e });
    throw e;
  }
  const outFile = path.join(cfg.output.dir, assembled.outputName);
  if (!o.write) return done({ project, result, assembled, outFile });

  fs.mkdirSync(cfg.output.dir, { recursive: true });
  fs.writeFileSync(outFile, assembled.text);
  if (cfg.output.lineMap) fs.writeFileSync(mapPath(outFile), JSON.stringify(assembled.map));
  else if (fs.existsSync(mapPath(outFile))) fs.rmSync(mapPath(outFile));

  const kb = (Buffer.byteLength(assembled.text) / 1024).toFixed(1);
  log.info(`${c.green('compiled')} ${path.relative(cfg.root, outFile)} ${c.gray(`· ${result.order.length} files · ${assembled.lineCount} lines · ${kb} KB · ${result.directives} directives · ${result.injections} injections · #${assembled.buildHash} · ${(performance.now() - t0).toFixed(0)}ms`)}`);
  log.verbose(`order: ${result.order.map((f) => result.files[f]!.rel).join(' → ')}`);

  let installedTo: string | undefined;
  if (o.install || cfg.install.enabled) {
    try {
      if (!cfg.install.dir) throw new AngelSpaceError('install.dir is not set and %APPDATA% is unavailable');
      installedTo = install(outFile, cfg.install.dir, (o.force ?? false) || cfg.install.overwrite);
      log.info(`${c.green('installed')} ${installedTo} ${c.gray('(reopen the Angel menu to refresh the script list)')}`);
    } catch (e) {
      if (e instanceof AngelSpaceError) return done({ project, result, assembled, outFile, error: e });
      throw e;
    }
  }
  return done({ project, result, assembled, outFile, installedTo });
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
