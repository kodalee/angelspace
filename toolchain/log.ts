// Leveled, colored, indented logger. Indent depth mirrors include depth so verbose
// output reads as a tree of what got pulled in from where.

export const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, verbose: 4, debug: 5 } as const;
export type Level = keyof typeof LEVELS;

let colorOverride: boolean | undefined;
export const setColor = (on: boolean) => { colorOverride = on; };
const useColor = () =>
  colorOverride ?? (!process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY));

const wrap = (code: string) => (s: unknown) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  dim: wrap('2'), bold: wrap('1'), red: wrap('31'), green: wrap('32'), yellow: wrap('33'),
  blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'), gray: wrap('90'),
};

const TAGS: Record<Exclude<Level, 'silent'>, () => string> = {
  error: () => c.red(c.bold('error  ')),
  warn: () => c.yellow(c.bold('warn   ')),
  info: () => c.cyan('info   '),
  verbose: () => c.gray('verbose'),
  debug: () => c.magenta('debug  '),
};

type Emit = (...parts: unknown[]) => void;
export interface Sink { error: Emit; warn: Emit; info: Emit; verbose: Emit; debug: Emit; }
export interface Logger extends Sink {
  readonly level: Level;
  setLevel(l: Level): void;
  enabled(l: Level): boolean;
  at(depth: number): Sink;
  counts: { warn: number; error: number };
}

export const isLevel = (s: string): s is Level => s in LEVELS;

export type Writer = (line: string, stream: 'out' | 'err') => void;
const stdWriter: Writer = (line, stream) => { (stream === 'err' ? process.stderr : process.stdout).write(line + '\n'); };

export function createLogger(level: Level = 'verbose', write: Writer = stdWriter): Logger {
  let threshold: number = LEVELS[level];
  const t0 = performance.now();
  const counts = { warn: 0, error: 0 };

  const emit = (lvl: Exclude<Level, 'silent'>, depth: number, parts: unknown[]) => {
    if (lvl === 'warn' || lvl === 'error') counts[lvl]++;
    if (LEVELS[lvl] > threshold) return;
    const ms = (performance.now() - t0).toFixed(1).padStart(7);
    const line = `${c.gray(ms + 'ms')} ${TAGS[lvl]()} ${'  '.repeat(depth)}${parts.join(' ')}`;
    write(line, lvl === 'error' || lvl === 'warn' ? 'err' : 'out');
  };
  const sink = (depth: number): Sink => ({
    error: (...p) => emit('error', depth, p),
    warn: (...p) => emit('warn', depth, p),
    info: (...p) => emit('info', depth, p),
    verbose: (...p) => emit('verbose', depth, p),
    debug: (...p) => emit('debug', depth, p),
  });

  return {
    ...sink(0),
    get level() { return (Object.keys(LEVELS) as Level[]).find((k) => LEVELS[k] === threshold) ?? 'verbose'; },
    setLevel(l) { threshold = LEVELS[l]; },
    enabled: (l) => LEVELS[l] <= threshold,
    at: sink,
    counts,
  };
}

/** A problem tied (optionally) to a source location — what editors turn into squiggles. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  loc?: Loc;
}

export interface Loc {
  rel: string;
  /** absolute path of the source file, when known */
  abs?: string;
  line: number;
  col: number;
  text?: string;
  chain?: string[];
}

// An error that knows where in the sources it happened.
export class AngelSpaceError extends Error {
  loc: Loc | undefined;
  constructor(message: string, loc?: Loc) {
    super(message);
    this.loc = loc;
  }

  format(): string {
    let out = `${c.red(c.bold('error'))}: ${this.message}`;
    const l = this.loc;
    if (!l) return out;
    out += `\n  ${c.blue('-->')} ${l.rel}:${l.line}:${l.col}`;
    if (l.text != null) {
      const src = l.text.split('\n')[l.line - 1] ?? '';
      const pad = ' '.repeat(String(l.line).length);
      out += `\n  ${pad} ${c.blue('|')}`;
      out += `\n  ${c.blue(l.line)} ${c.blue('|')} ${src}`;
      out += `\n  ${pad} ${c.blue('|')} ${' '.repeat(Math.max(0, l.col - 1))}${c.red('^')}`;
    }
    for (const from of l.chain ?? []) out += `\n  ${c.gray('included from ' + from)}`;
    return out;
  }
}
