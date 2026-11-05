#!/usr/bin/env node
// AngelSpace — compiles a multi-file .ass workspace into one Angel .as script.
//
// This folder is the AngelSpace toolchain. It serves exactly one project: the folder it sits in.
//   <repo>/toolchain/        ← this folder
//   <repo>/angelspace.yaml   ┐ written by `npm run create`
//   <repo>/src/main.ass      ┘
// Run it through the npm scripts in <repo>/package.json (`npm run create`, `npm run build`, …).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { AngelSpaceError, c, createLogger, setColor, type Level, type Logger } from './log.ts';
import { CONFIG_NAMES, loadConfig, PROJECT_ROOT, projectConfig } from './config.ts';
import { scaffold } from './templates.ts';
import { ANGELSPACE_VERSION, BUILTIN_DOCS, POST_BUILD_DOCS } from './builtins.ts';
import { readMap, renderTemplate } from './output.ts';
import { buildProject, loadProject, type Project } from './project.ts';
import { toLiteral, toRaw } from './values.ts';
import { serve } from './serve.ts';

const HELP = `${c.bold('angelspace')} ${ANGELSPACE_VERSION} — compile a .ass workspace into one Angel script

${c.bold('commands')}         (run from the repo root)
  npm run create                     start a new project in this folder (angelspace.yaml + src/)
  npm run build                      compile src/ (from main) into the output .as
  npm run build:install              compile and copy into the Angel scripts folder
  npm run watch                      compile, then recompile on every change
  npm run where -- <line>...         map compiled-script line numbers back to .ass sources
  npm run vars                       list every pre-compile variable and its value
  npm run help                       this help (version: npm run angelspace -- version)

${c.bold('options')}          (after --, e.g. npm run build -- -D channel=release)
  -c, --config <file>      config file (default: the angelspace.yaml in the repo root)
  -D, --define <k=v>       set/override a variable, e.g. -D channel=release (repeatable)
      --install            copy the output into the Angel scripts folder
      --force              let --install overwrite a script AngelSpace didn't write
      --no-watermark       omit the build watermark
      --no-headers         omit the per-file "referenced by" headers
  -q, --quiet              errors and warnings only
  -v, --verbose            verbose logging (the default)
      --debug              everything, including each injection and timing
      --no-color           plain output

${c.bold('create options')}   (skip the matching question)
      --name <name>        project name (default: folder name)
      --target <exe>       process Angel attaches to (default: game.exe)
      --module <dll>       main module to resolve (default: the exe)
      --template <t>       starter (modules wired with includes) | minimal (default: starter)
  -y, --yes                don't ask anything: use the options and defaults

${c.bold('internal')}         serve: the editor interface (JSON over stdio) the VS Code extension starts
`;

interface Args {
  cmd: string; rest: string[]; config?: string; defines: [string, string][];
  install: boolean; force: boolean; watermark: boolean; headers: boolean; level?: Level;
  init: { name?: string; target?: string; module?: string; template?: string; yes?: boolean };
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: 'compile', rest: [], defines: [], install: false, force: false, watermark: true, headers: true, init: {} };
  let cmdSet = false;
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k]!;
    const next = () => {
      const val = argv[++k];
      if (val === undefined) throw new AngelSpaceError(`${arg} needs a value`);
      return val;
    };
    const define = (kv: string) => {
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new AngelSpaceError(`-D expects name=value, got '${kv}'`);
      a.defines.push([kv.slice(0, eq), kv.slice(eq + 1)]);
    };
    if (arg === '-c' || arg === '--config') a.config = next();
    else if (arg === '-D' || arg === '--define') define(next());
    else if (arg.startsWith('-D') && arg.length > 2) define(arg.slice(2));
    else if (arg.startsWith('--define=')) define(arg.slice(9));
    else if (arg === '--install') a.install = true;
    else if (arg === '--force') a.force = true;
    else if (arg === '--no-watermark') a.watermark = false;
    else if (arg === '--no-headers') a.headers = false;
    else if (arg === '-q' || arg === '--quiet') a.level = 'warn';
    else if (arg === '-v' || arg === '--verbose') a.level = 'verbose';
    else if (arg === '--debug') a.level = 'debug';
    else if (arg === '--no-color') setColor(false);
    else if (arg === '-h' || arg === '--help') { a.cmd = 'help'; cmdSet = true; }
    else if (arg === '--version') { a.cmd = 'version'; cmdSet = true; }
    else if (arg === '--watch') a.cmd = 'watch';
    else if (arg === '--name') a.init.name = next();
    else if (arg === '--target') a.init.target = next();
    else if (arg === '--module') a.init.module = next();
    else if (arg === '--template') a.init.template = next();
    else if (arg === '-y' || arg === '--yes') a.init.yes = true;
    else if (arg.startsWith('-')) throw new AngelSpaceError(`unknown option ${arg} (see npm run help)`);
    else if (!cmdSet) { a.cmd = arg === 'build' ? 'compile' : arg === 'init' ? 'create' : arg; cmdSet = true; }
    else a.rest.push(arg);
  }
  return a;
}

function configPath(args: Args): string {
  if (args.config) {
    const file = path.resolve(args.config);
    if (!fs.existsSync(file)) throw new AngelSpaceError(`config not found: ${args.config}`);
    return file;
  }
  const file = projectConfig();
  if (!file) {
    throw new AngelSpaceError(`there's no project in ${PROJECT_ROOT} yet (no angelspace.yaml) — run "npm run create" to start one`);
  }
  return file;
}

function setup(args: Args, log: Logger): Project {
  return loadProject(configPath(args), log, args.defines);
}

function runCompile(args: Args, log: Logger): void {
  const file = configPath(args);
  if (!args.level) {
    // Pick up log.level from the config before building (quietly).
    try { log.setLevel(loadConfig(file, createLogger('silent')).log.level); } catch { /* reported by the build */ }
  }
  const out = buildProject({
    configPath: file, log, overrides: args.defines, write: true,
    watermark: args.watermark, headers: args.headers, install: args.install, force: args.force,
  });
  if (out.error) throw out.error;
}

function runWatch(args: Args, log: Logger): void {
  const build = () => {
    try { runCompile(args, log); }
    catch (e) { report(e, log); }
    log.info(c.gray('watching for changes… (ctrl+c to stop)'));
  };
  build();
  let file: string;
  try { file = configPath(args); } catch { return; }
  const cfg = loadConfig(file, createLogger('silent'));
  let timer: NodeJS.Timeout | undefined;
  const queue = (what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => { log.info(`${c.cyan('change')} ${what}`); build(); }, 120);
  };
  fs.watch(cfg.src, { recursive: true }, (_ev, name) => queue(name ? String(name) : 'src'));
  fs.watch(file, () => queue(path.basename(file)));
}

function runWhere(args: Args, log: Logger): void {
  const { cfg, vars } = setup(args, createLogger('warn'));
  if (!args.rest.length) throw new AngelSpaceError('usage: npm run where -- <line> [line...]');
  const outFile = path.join(cfg.output.dir, renderTemplate(cfg.output.file, vars, 'output.file'));
  const map = readMap(outFile);
  for (const a of args.rest) {
    const n = Number(a.replace(/^.*:/, ''));
    if (!Number.isInteger(n) || n < 1) throw new AngelSpaceError(`not a line number: ${a}`);
    const hit = map.lines[n - 1];
    if (hit === undefined) { log.warn(`${map.output}:${n} is past the end of the file (${map.lines.length} lines)`); continue; }
    if (hit === null) { console.log(`${map.output}:${n} → ${c.gray('generated by AngelSpace (watermark/header)')}`); continue; }
    const [si, line] = hit;
    const srcRel = map.sources[si]!;
    let code = '';
    try { code = fs.readFileSync(path.resolve(cfg.root, srcRel), 'utf8').split(/\r?\n/)[line - 1]?.trim() ?? ''; } catch { /* source moved */ }
    console.log(`${map.output}:${n} → ${c.bold(`${srcRel}:${line}`)}${code ? c.gray(`   ${code}`) : ''}`);
  }
}

function runVars(args: Args): void {
  const { vars, origin } = setup(args, createLogger('warn'));
  const rows = [...vars].map(([k, val]) => [k, origin.get(k) ?? '', val.type, toLiteral(val), BUILTIN_DOCS[k] ?? ''] as const);
  const w = (i: 0 | 1 | 2 | 3) => Math.max(...rows.map((r) => r[i].length));
  for (const r of rows) {
    console.log(`${c.bold(r[0].padEnd(w(0)))}  ${c.gray(r[1].padEnd(w(1)))}  ${r[2].padEnd(w(2))}  ${r[3].padEnd(Math.min(w(3), 40))}  ${c.gray(r[4])}`);
  }
  console.log(c.gray(`\nper use site: __FILE__ (source file, relative to src/), __LINE__ (source line)`));
  console.log(c.gray(`watermark only: ${Object.keys(POST_BUILD_DOCS).join(', ')}`));
  console.log(c.gray(`#[name] → raw text (e.g. ${toRaw(vars.get('compileTime')!)}),  $name → literal (e.g. ${toLiteral(vars.get('compileTime')!)})`));
}

async function runCreate(args: Args, log: Logger): Promise<void> {
  const dir = PROJECT_ROOT;
  if (CONFIG_NAMES.some((n) => fs.existsSync(path.join(dir, n)))) {
    throw new AngelSpaceError(`${dir} already has a project (angelspace.yaml) — "npm run build" compiles it`);
  }
  const o = args.init;
  console.log([
    '',
    `${c.bold('Starting a new AngelSpace project')} in ${c.cyan(dir)}`,
    '  angelspace.yaml   project config: name, target, variables, output',
    '  src/              your code (src/main.ass is the entry point)',
    '  .vscode/          editor settings and build tasks',
    c.gray('Files that already exist are kept, never overwritten.'),
    '',
  ].join('\n'));
  if (fs.existsSync(path.join(dir, 'src')) && fs.readdirSync(path.join(dir, 'src')).length) {
    log.warn('src/ already has files in it; the template only adds the ones that are missing');
  }

  const ask = !o.yes && process.stdin.isTTY;
  let name = o.name, target = o.target, module = o.module, template = o.template;
  if (ask) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const q = async (label: string, def: string) => (await rl.question(`${label} ${c.gray(`(${def || 'blank'})`)}: `)).trim() || def;
    try {
      name ??= await q('Project name', path.basename(dir));
      target ??= await q('Process Angel attaches to', 'game.exe');
      module ??= await q('Main module to resolve, blank = the exe', '');
      template ??= await q('Template: starter (modules wired with includes) or minimal', 'starter');
      if (!/^y(es)?$/i.test(await q(`\nCreate the project in ${dir}?`, 'y'))) { log.info('cancelled, nothing was written'); return; }
    } finally { rl.close(); }
  }
  template ??= 'starter';
  if (template !== 'starter' && template !== 'minimal') throw new AngelSpaceError(`template must be starter or minimal, got '${template}'`);
  const files = scaffold({ name: name ?? path.basename(dir), target: target ?? 'game.exe', module: module ?? '', template });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { log.warn(`kept existing ${rel}`); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.ass') ? content.replace(/\n/g, '\r\n') : content);
    log.verbose(`created ${rel}`);
  }
  log.info(`${c.green('created')} ${template} project in ${dir}`);
  log.info(c.gray('next: npm run build   (or npm run watch)'));
}

function report(e: unknown, log: Logger) {
  if (e instanceof AngelSpaceError) log.error(e.format());
  else log.error((e as Error)?.stack ?? String(e));
}

async function main() {
  const log = createLogger('verbose');
  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { report(e, log); process.exitCode = 2; return; }
  if (args.level) log.setLevel(args.level);
  try {
    switch (args.cmd) {
      case 'create': await runCreate(args, log); break;
      case 'compile': runCompile(args, log); break;
      case 'watch': runWatch(args, log); break;
      case 'where': runWhere(args, log); break;
      case 'vars': runVars(args); break;
      case 'serve': serve(configPath(args)); break;
      case 'version': console.log(ANGELSPACE_VERSION); break;
      case 'help': console.log(HELP); break;
      default: throw new AngelSpaceError(`unknown command '${args.cmd}' (see npm run help)`);
    }
  } catch (e) {
    report(e, log);
    process.exitCode = 1;
  }
}

void main();
