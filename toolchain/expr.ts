// Condition expressions for #[if ...] / #[ifn ...] / #[elif ...] / #[elifn ...].
//
//   literals    "beta"  'beta'  1.0  0x10  true  false  null
//   variables   channel  version  __FILE__ ...
//   functions   defined(name)
//   operators   !  ==  !=  <  <=  >  >=  &&  ||  ( )
//
// Numbers compare numerically. Two version-looking strings ("1.10" vs "1.9") compare
// part by part. A number against a string compares the number's exact spelling, so
// `version == "1.0"` holds whether version was written as 1.0 or "1.0".

import { v, truthy, toRaw, type Value } from './values.ts';

type Tok =
  | { t: 'num'; raw: string }
  | { t: 'str'; value: string }
  | { t: 'id'; name: string }
  | { t: 'op'; op: string };

const TOKEN = /\s*(?:(0x[0-9a-fA-F]+|\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?|("(?:[^"\\]|\\.)*"|'[^']*')|([A-Za-z_]\w*)|(==|!=|<=|>=|&&|\|\||[!<>()]))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (src.slice(TOKEN.lastIndex).trim() !== '') {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`unexpected character '${src.slice(at).trimStart()[0]}' in condition`);
    if (m[1] !== undefined) out.push({ t: 'num', raw: m[1] + (m[2] ?? '') });
    else if (m[3] !== undefined) out.push({ t: 'str', value: m[3][0] === '"' ? (JSON.parse(m[3]) as string) : m[3].slice(1, -1) });
    else if (m[4] !== undefined) out.push({ t: 'id', name: m[4] });
    else out.push({ t: 'op', op: m[5]! });
  }
  return out;
}

const describe = (t: Tok) => (t.t === 'op' ? t.op : t.t === 'id' ? t.name : t.t === 'num' ? t.raw : JSON.stringify(t.value));

export function evaluate(src: string, lookup: (name: string) => Value | undefined): boolean {
  const toks = tokenize(src);
  if (!toks.length) throw new Error('empty condition');
  let i = 0;
  const isOp = (op: string) => { const t = toks[i]; return t?.t === 'op' && t.op === op; };
  const expect = (op: string) => { if (!isOp(op)) throw new Error(`expected '${op}' in condition`); i++; };

  const or = (): Value => { let l = and(); while (isOp('||')) { i++; const r = and(); l = v.bool(truthy(l) || truthy(r)); } return l; };
  const and = (): Value => { let l = cmp(); while (isOp('&&')) { i++; const r = cmp(); l = v.bool(truthy(l) && truthy(r)); } return l; };
  const cmp = (): Value => {
    let l = unary();
    for (;;) {
      const t = toks[i];
      if (t?.t !== 'op' || !['==', '!=', '<', '<=', '>', '>='].includes(t.op)) return l;
      i++;
      l = v.bool(compare(l, unary(), t.op));
    }
  };
  const unary = (): Value => { if (isOp('!')) { i++; return v.bool(!truthy(unary())); } return primary(); };
  const primary = (): Value => {
    const t = toks[i++];
    if (!t) throw new Error('condition ends unexpectedly');
    if (t.t === 'num') return v.number(Number(t.raw), t.raw);
    if (t.t === 'str') return v.string(t.value);
    if (t.t === 'op') {
      if (t.op !== '(') throw new Error(`unexpected '${t.op}' in condition`);
      const e = or(); expect(')'); return e;
    }
    if (t.name === 'true' || t.name === 'false') return v.bool(t.name === 'true');
    if (t.name === 'null') return v.null();
    if (t.name === 'defined') {
      expect('(');
      const n = toks[i++];
      if (n?.t !== 'id') throw new Error('defined() takes a variable name');
      expect(')');
      return v.bool(lookup(n.name) !== undefined);
    }
    const val = lookup(t.name);
    if (val === undefined) throw new Error(`undefined variable '${t.name}' in condition (test it with defined(${t.name}))`);
    return val;
  };

  const result = or();
  if (i < toks.length) throw new Error(`unexpected '${describe(toks[i]!)}' after condition`);
  return truthy(result);
}

const VERSIONISH = /^\d+(\.\d+)*$/;
const isText = (x: Value) => x.type === 'number' || x.type === 'string';

function compare(a: Value, b: Value, op: string): boolean {
  let d: number;
  if (a.type === 'number' && b.type === 'number') d = a.value - b.value;
  else if (a.type === 'string' && b.type === 'string' && VERSIONISH.test(a.value) && VERSIONISH.test(b.value)) d = versionCmp(a.value, b.value);
  else if (op === '==' || op === '!=') {
    const eq = (a.type === b.type || (isText(a) && isText(b))) && toRaw(a) === toRaw(b);
    return op === '==' ? eq : !eq;
  } else if (a.type === 'string' && b.type === 'string') d = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  else if (isText(a) && isText(b)) d = versionCmp(toRaw(a), toRaw(b));
  else throw new Error(`cannot order ${a.type} and ${b.type} with '${op}'`);
  switch (op) {
    case '==': return d === 0;
    case '!=': return d !== 0;
    case '<': return d < 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    default: return d >= 0;
  }
}

function versionCmp(x: string, y: string): number {
  const a = x.split('.'), b = y.split('.');
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const p = Number(a[k] ?? 0), q = Number(b[k] ?? 0);
    if (Number.isNaN(p) || Number.isNaN(q)) return x < y ? -1 : x > y ? 1 : 0;
    if (p !== q) return p - q;
  }
  return 0;
}
