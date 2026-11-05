// Loads and validates angelspace.yaml.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type YAMLModule from 'yaml';
import { fromJs, v, type Value } from './values.ts';
import { AngelSpaceError, isLevel, type Level, type Logger } from './log.ts';

export const CONFIG_NAMES = ['angelspace.yaml', 'angelspace.yml'];

// Words the directive syntax owns; a variable can't take them.
export const RESERVED = new Set(['if', 'ifn', 'elif', 'elifn', 'else', 'endif', 'include', 'error', 'warn', 'info', 'defined', 'true', 'false', 'null']);
export const NAME = /^[A-Za-z_]\w*$/;

const DEFAULT_WATERMARK = ['Compiled with AngelSpace by Koda | Compiled at #[compileTime] / #[compileEpoch]'];

const KNOWN: Record<string, string[]> = {
  '': ['name', 'target', 'src', 'main', 'defines', 'output', 'install', 'log'],
  output: ['dir', 'file', 'lineEndings', 'fileHeaders', 'lineMap', 'watermark'],
  'output.watermark': ['enabled', 'lines'],
  install: ['enabled', 'dir', 'overwrite'],
  log: ['level'],
};

export interface Config {
  file: string;
  root: string;
  name: string;
  target: string;
  src: string;
  main: string;
  mainAbs: string;
  defines: Map<string, Value>;
  output: {
    dir: string;
    file: string;
    lineEndings: 'crlf' | 'lf';
    fileHeaders: boolean;
    lineMap: boolean;
    watermark: { enabled: boolean; lines: string[] };
  };
  install: { enabled: boolean; dir: string | null; overwrite: boolean };
  log: { level: Level };
}

// `yaml` is loaded on first use, so commands that don't read a config (`create`, `help`) work in
// a freshly cloned system before `npm install` has run.
let yamlModule: typeof YAMLModule | undefined;
function yaml(): typeof YAMLModule {
  if (!yamlModule) {
    try { yamlModule = createRequire(import.meta.url)('yaml') as typeof YAMLModule; }
    catch { throw new AngelSpaceError('the AngelSpace system\'s dependencies are missing — run "npm install" in the repo root'); }
  }
  return yamlModule;
}

// The toolchain lives in <repo>/toolchain/ and serves exactly one project: the repo root it sits in.
// Your sources sit next to it (<repo>/src/), configured by <repo>/angelspace.yaml (`npm run create`).
export const SYSTEM_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.dirname(SYSTEM_DIR);

/** The angelspace.yaml next to this system, if there is one. */
export function projectConfig(): string | null {
  return CONFIG_NAMES.map((n) => path.join(PROJECT_ROOT, n)).find((p) => fs.existsSync(p)) ?? null;
}

const expandEnv = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, k: string) => {
  const val = process.env[k];
  if (val === undefined) throw new AngelSpaceError(`config references \${${k}}, but that environment variable is not set`);
  return val;
});

type Raw = Record<string, unknown>;
const obj = (x: unknown): Raw => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Raw) : {});

export function loadConfig(file: string, log: Logger): Config {
  const text = fs.readFileSync(file, 'utf8');
  const doc = yaml().parseDocument(text, { keepSourceTokens: true, prettyErrors: true });
  if (doc.errors.length) {
    throw new AngelSpaceError(`invalid YAML in ${path.basename(file)}:\n${doc.errors.map((e) => '  ' + e.message).join('\n')}`);
  }
  const raw = obj(doc.toJS());
  const root = path.dirname(file);
  log.verbose(`config ${path.relative(process.cwd(), file) || file}`);

  // A typo'd key silently does nothing, so call it out.
  for (const [scope, keys] of Object.entries(KNOWN)) {
    const section = scope ? scope.split('.').reduce<unknown>((o, k) => obj(o)[k], raw) : raw;
    if (section && typeof section === 'object') {
      for (const k of Object.keys(section)) if (!keys.includes(k)) log.warn(`unknown config key '${scope ? scope + '.' : ''}${k}' (ignored)`);
    }
  }

  const str = (val: unknown, key: string, dflt: string): string => {
    if (val === undefined || val === null) return dflt;
    if (typeof val !== 'string') throw new AngelSpaceError(`config '${key}' must be a string`);
    return val;
  };
  const bool = (val: unknown, key: string, dflt: boolean): boolean => {
    if (val === undefined || val === null) return dflt;
    if (typeof val !== 'boolean') throw new AngelSpaceError(`config '${key}' must be true or false`);
    return val;
  };

  const name = str(raw.name, 'name', path.basename(root));
  const src = path.resolve(root, str(raw.src, 'src', 'src'));
  const main = str(raw.main, 'main', 'main.ass').replace(/^[\\/]+/, '');
  const mainAbs = path.resolve(src, main);
  if (!fs.existsSync(src)) throw new AngelSpaceError(`source folder not found: ${src}`);
  if (!fs.existsSync(mainAbs)) throw new AngelSpaceError(`main file not found: ${path.relative(root, mainAbs)}`);

  const out = obj(raw.output);
  const lineEndings = str(out.lineEndings, 'output.lineEndings', 'crlf').toLowerCase();
  if (lineEndings !== 'crlf' && lineEndings !== 'lf') throw new AngelSpaceError(`config 'output.lineEndings' must be crlf or lf`);
  const wm = obj(out.watermark);
  const wmLines = wm.lines ?? DEFAULT_WATERMARK;
  if (!Array.isArray(wmLines) || wmLines.some((l) => typeof l !== 'string')) {
    throw new AngelSpaceError(`config 'output.watermark.lines' must be a list of strings`);
  }

  const inst = obj(raw.install);
  const level = str(obj(raw.log).level, 'log.level', 'verbose');
  if (!isLevel(level)) throw new AngelSpaceError(`config 'log.level' must be one of silent, error, warn, info, verbose, debug`);

  return {
    file, root, name, src, main, mainAbs,
    target: str(raw.target, 'target', ''),
    defines: readDefines(doc),
    output: {
      dir: path.resolve(root, expandEnv(str(out.dir, 'output.dir', 'dist'))),
      file: str(out.file, 'output.file', '#[projectName].as'),
      lineEndings,
      fileHeaders: bool(out.fileHeaders, 'output.fileHeaders', true),
      lineMap: bool(out.lineMap, 'output.lineMap', true),
      watermark: { enabled: bool(wm.enabled, 'output.watermark.enabled', true), lines: wmLines as string[] },
    },
    install: {
      enabled: bool(inst.enabled, 'install.enabled', false),
      dir: inst.dir != null
        ? path.resolve(root, expandEnv(str(inst.dir, 'install.dir', '')))
        : process.env.APPDATA ? path.join(process.env.APPDATA, 'scripts') : null,
      overwrite: bool(inst.overwrite, 'install.overwrite', false),
    },
    log: { level },
  };
}

// Read `defines:` from the YAML AST rather than toJS() so numbers keep their spelling.
function readDefines(doc: YAMLModule.Document.Parsed): Map<string, Value> {
  const map = new Map<string, Value>();
  const node = doc.get('defines', true);
  if (node == null) return map;
  if (!yaml().isMap(node)) throw new AngelSpaceError(`config 'defines' must be a map of name: value`);
  for (const pair of node.items) {
    const key = String(yaml().isScalar(pair.key) ? pair.key.value : pair.key);
    if (!NAME.test(key)) throw new AngelSpaceError(`define '${key}' is not a valid name (letters, digits and _, not starting with a digit)`);
    if (RESERVED.has(key)) throw new AngelSpaceError(`define '${key}' is a reserved word`);
    map.set(key, nodeValue(pair.value, key));
  }
  return map;
}

function nodeValue(n: unknown, key: string): Value {
  if (n == null) return v.null();
  if (yaml().isSeq(n)) return v.list(n.items.map((i) => nodeValue(i, key)));
  if (yaml().isMap(n)) throw new AngelSpaceError(`define '${key}' is a map; only strings, numbers, booleans, null and lists are supported`);
  if (yaml().isScalar(n)) {
    if (typeof n.value === 'number') {
      const src = (n as { srcToken?: { source?: string } }).srcToken?.source;
      return v.number(n.value, src ?? String(n.value));
    }
    return fromJs(n.value);
  }
  return fromJs(n);
}
