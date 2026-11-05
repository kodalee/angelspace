// Variables every build gets for free. Config `defines:` and `-D` can override them.

import fs from 'node:fs';
import { v, type Value } from './values.ts';
import type { Config } from './config.ts';

export const ANGELSPACE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const BUILTIN_DOCS: Record<string, string> = {
  angelSpaceVersion: 'version of the AngelSpace compiler',
  compileEpoch: 'build time, unix seconds (honors SOURCE_DATE_EPOCH)',
  compileEpochMs: 'build time, unix milliseconds',
  compileTime: 'build time, ISO-8601 UTC, e.g. 2026-11-05T06:24:48Z',
  compileDate: 'build date, YYYY-MM-DD (UTC)',
  projectName: 'name from angelspace.yaml',
  target: 'target process from angelspace.yaml',
  mainFile: 'main file, relative to src/',
  runtime: '"node" or "bun"',
  runtimeVersion: 'version of the runtime',
  hostOS: 'platform the build ran on (win32, darwin, linux)',
  __FILE__: 'current source file, relative to src/ (per use site)',
  __LINE__: 'current source line (per use site)',
};

/** Only available in watermark lines, since they describe the finished output. */
export const POST_BUILD_DOCS: Record<string, string> = {
  fileCount: 'number of source files in the build',
  lineCount: 'lines in the compiled script (excluding the watermark)',
  buildHash: 'first 12 hex chars of the SHA-256 of the compiled script',
  outputFile: 'output file name',
};

export function builtinVars(cfg: Config, now: Date): Map<string, Value> {
  const sde = process.env.SOURCE_DATE_EPOCH;
  const ms = sde && /^\d+$/.test(sde) ? Number(sde) * 1000 : now.getTime();
  const iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return new Map<string, Value>([
    ['angelSpaceVersion', v.string(ANGELSPACE_VERSION)],
    ['compileEpoch', v.number(Math.floor(ms / 1000))],
    ['compileEpochMs', v.number(ms)],
    ['compileTime', v.string(iso)],
    ['compileDate', v.string(iso.slice(0, 10))],
    ['projectName', v.string(cfg.name)],
    ['target', v.string(cfg.target)],
    ['mainFile', v.string(cfg.main)],
    ['runtime', v.string(bun ? 'bun' : 'node')],
    ['runtimeVersion', v.string(bun ? bun.version : process.versions.node)],
    ['hostOS', v.string(process.platform)],
  ]);
}
