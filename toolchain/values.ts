// Pre-compile variable values and how they render into AngelScript.
//
// Numbers keep `raw`, their exact source spelling ("1.0", "0x10"), so they render
// exactly as written instead of being normalized by JS ("1.0" -> "1").

export type Value =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number; raw: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null'; value: null }
  | { type: 'list'; value: Value[] };

export const v = {
  string: (s: string): Value => ({ type: 'string', value: s }),
  number: (n: number, raw?: string): Value => ({ type: 'number', value: n, raw: raw ?? String(n) }),
  bool: (b: boolean): Value => ({ type: 'bool', value: b }),
  null: (): Value => ({ type: 'null', value: null }),
  list: (items: Value[]): Value => ({ type: 'list', value: items }),
};

export function fromJs(x: unknown): Value {
  if (x === null || x === undefined) return v.null();
  if (typeof x === 'boolean') return v.bool(x);
  if (typeof x === 'number') return v.number(x);
  if (typeof x === 'bigint') return v.number(Number(x), x.toString());
  if (Array.isArray(x)) return v.list(x.map(fromJs));
  if (typeof x === 'object') throw new Error('maps are not supported as variable values');
  return v.string(String(x));
}

// `-D key=value` uses YAML-like rules, except numbers keep their exact spelling.
export function fromCli(text: string): Value {
  const t = text.trim();
  if (t === 'true' || t === 'false') return v.bool(t === 'true');
  if (t === 'null' || t === '~') return v.null();
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t) || /^0x[0-9a-f]+$/i.test(t)) return v.number(Number(t), t);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return v.string(JSON.parse(t) as string);
  if (/^'.*'$/.test(t)) return v.string(t.slice(1, -1));
  return v.string(text);
}

/** `#[name]` — the value as plain text, no quoting. */
export function toRaw(val: Value): string {
  switch (val.type) {
    case 'string': return val.value;
    case 'number': return val.raw;
    case 'bool': return val.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'list': return val.value.map(toRaw).join(', ');
  }
}

/** `$name` — the value as a ready-to-use AngelScript expression. */
export function toLiteral(val: Value): string {
  switch (val.type) {
    case 'string': return asString(val.value);
    case 'number': return val.raw;
    case 'bool': return val.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'list': return '{' + val.value.map(toLiteral).join(', ') + '}';
  }
}

export function asString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + '"';
}

export function truthy(val: Value): boolean {
  switch (val.type) {
    case 'string': return val.value.length > 0;
    case 'number': return val.value !== 0 && !Number.isNaN(val.value);
    case 'bool': return val.value;
    case 'null': return false;
    case 'list': return val.value.length > 0;
  }
}
