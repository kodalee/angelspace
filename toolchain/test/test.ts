// Tests for the AngelSpace toolchain.   npm test   (node toolchain/test/test.ts)
//
// Most tests work on a fresh "clone" in a temp folder: a copy of this repo with no project in it,
// then `create` adds <tmp>/angelspace.yaml and <tmp>/src/ the way `npm run create` does.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../templates.ts';
import { buildProject } from '../project.ts';
import { createLogger } from '../log.ts';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
const results: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${String((e as Error)?.stack ?? e).split('\n').slice(0, 6).join('\n    ')}`); process.exitCode = 1; }
  };
  test.queue(run);
}

const section = (title: string) => test.queue(() => console.log(title));
test.queue = (fn: () => void) => { results.push((results[results.length - 1] ?? Promise.resolve()).then(fn)); };

const temps: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };

/** A fresh copy of this repo with no project in it yet (dependencies linked, not copied). */
function project(): string {
  const dir = tmp('angelspace-test-');
  for (const e of fs.readdirSync(repo)) {
    if (['node_modules', '.git', 'src', 'dist', '.vscode', 'angelspace.yaml', 'angelspace.yml'].includes(e)) continue;
    fs.cpSync(path.join(repo, e), path.join(dir, e), { recursive: true });
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

const cli = (dir: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(dir, 'toolchain', 'cli.ts'), '--no-color', ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

section('templates');
for (const template of ['starter', 'minimal'] as const) {
  test(`${template} template compiles cleanly`, () => {
    const dir = tmp('angelspace-scaffold-');
    for (const [rel, content] of Object.entries(scaffold({ name: 'My Script', target: 'game.exe', module: 'client.dll', template }))) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const out = buildProject({ configPath: path.join(dir, 'angelspace.yaml'), log: createLogger('silent'), write: true });
    assert.equal(out.error, undefined, out.error?.message);
    assert.deepEqual(out.diagnostics, []);
    const text = fs.readFileSync(out.outFile!, 'utf8');
    assert.match(text, /^\/\/ Compiled with AngelSpace by Koda/);
    assert.ok(text.includes('const string Process = "game.exe";') || template === 'minimal');
    const code = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments keep directives inert
    assert.ok(!/#\[|\$[A-Za-z_]/.test(code), 'no directives left in code');
    if (template === 'starter') assert.ok(text.indexOf('class GameMemory') < text.indexOf('bool main()'), 'deps above main');
  });
}
test('every command is an npm script that runs the toolchain', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts;
  const expected = { create: 'create', build: 'compile', 'build:install': 'compile --install', watch: 'watch', where: 'where', vars: 'vars', help: 'help' };
  for (const [name, cmd] of Object.entries(expected)) assert.equal(scripts[name], `node toolchain/cli.ts ${cmd}`, name);
  assert.equal(scripts.install, undefined, '"install" would run on every npm install');
});
test("create never writes the repo's own files", () => {
  for (const f of Object.keys(scaffold({ name: 'x', target: 'game.exe', module: '', template: 'starter' }))) {
    assert.ok(f === 'angelspace.yaml' || f.startsWith('src/') || f.startsWith('.vscode/'), f);
  }
});

section('compiler');
test('inactive lines, overlays and diagnostics', () => {
  const dir = tmp('angelspace-unit-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'angelspace.yaml'), 'name: t\ndefines:\n  channel: beta\n');
  fs.writeFileSync(path.join(dir, 'src', 'main.ass'), 'old\n');
  fs.writeFileSync(path.join(dir, 'src', 'orphan.ass'), '');
  const main = path.join(dir, 'src', 'main.ass');
  const overlay = '#[if channel == "release"]\nrelease_only();\nalso();\n#[endif]\n#[warn "careful"]\nkeep();\n';
  const out = buildProject({ configPath: path.join(dir, 'angelspace.yaml'), log: createLogger('silent'), readFile: (p) => (path.resolve(p) === path.resolve(main) ? overlay : undefined) });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.result!.inactive.get(out.result!.mainIdx), [2, 3]);
  assert.ok(out.diagnostics.some((d) => d.severity === 'warning' && d.message === 'careful' && d.loc?.line === 5));
  assert.ok(out.diagnostics.some((d) => d.loc?.abs?.endsWith('orphan.ass') && /never included/.test(d.message)));
  const bad = buildProject({ configPath: path.join(dir, 'angelspace.yaml'), log: createLogger('silent'), readFile: (p) => (path.resolve(p) === path.resolve(main) ? 'x = $nope;\n' : undefined) });
  assert.match(bad.error!.message, /undefined variable 'nope'/);
  assert.equal(bad.diagnostics[0]!.loc?.abs, main);
  assert.equal(bad.diagnostics[0]!.loc?.col, 5);
});

section('cli (in a fresh clone)');
test('before create, it says to run npm run create', () => {
  const r = cli(project(), 'compile');
  assert.equal(r.code, 1);
  assert.match(r.out, /npm run create/);
});
test('version comes from the repo package.json', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(cli(project(), 'version').out.trim(), version);
});
test('create starts the project in the repo root, compile builds it, where maps back', () => {
  const dir = project();
  const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const create = cli(dir, 'create', '--name', 'Demo', '--target', 'demo.exe');
  assert.equal(create.code, 0, create.out);
  assert.match(create.out, /Starting a new AngelSpace project/);
  for (const f of ['angelspace.yaml', 'src/main.ass', '.vscode/tasks.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), pkg, 'package.json untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'toolchain', 'angelspace.yaml')), 'nothing scaffolded inside the toolchain');
  assert.match(cli(dir, 'create').out, /already has a project/);
  const build = cli(dir, 'compile');
  assert.equal(build.code, 0, build.out);
  const outFile = path.join(dir, 'dist', 'demo.as');
  assert.ok(fs.existsSync(outFile) && fs.existsSync(outFile + '.map.json'));
  const line = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('bool main()')) + 1;
  const where = cli(dir, 'where', String(line));
  assert.match(where.out, /main\.ass:\d+/);
});
test('npm run create, then npm run build', () => {
  const dir = project();
  const c = spawnSync('npm run create --silent -- --yes --template minimal', { cwd: dir, encoding: 'utf8', shell: true });
  assert.equal(c.status, 0, (c.stdout ?? '') + (c.stderr ?? ''));
  const r = spawnSync('npm run build --silent', { cwd: dir, encoding: 'utf8', shell: true });
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
  assert.ok(fs.readdirSync(path.join(dir, 'dist')).some((f) => f.endsWith('.as')));
});

section('serve (editor protocol)');
test('hello, analyze with overlays, resolveInclude, compile, where', async () => {
  const dir = project();
  assert.equal(cli(dir, 'create', '--name', 'svc').code, 0);
  const child = spawn(process.execPath, [path.join(dir, 'toolchain', 'cli.ts'), 'serve'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
  let id = 0;
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    child.stdin!.write(JSON.stringify({ id: n, method, params }) + '\n');
  });
  try {
    const hello = await call('hello');
    assert.equal(hello.protocol, 1);
    assert.equal(path.resolve(hello.root), path.resolve(dir));

    const a = await call('analyze');
    assert.equal(a.error, undefined);
    assert.equal(a.project.name, 'svc');
    assert.ok(a.project.vars.some((v: any) => v.name === 'channel' && v.literal === '"dev"' && v.origin === 'config'));
    assert.equal(a.result.files[a.result.mainIdx].rel, 'main.ass');
    assert.ok(a.result.order.length >= 5);
    assert.equal(path.basename(a.project.outFile), 'svc.as');

    const main = path.join(dir, 'src', 'main.ass');
    const bad = await call('analyze', { overlays: { [main]: 'int x = $nope;\n' } });
    assert.match(bad.error.message, /undefined variable 'nope'/);
    assert.equal(bad.diagnostics[0].loc.lineText, 'int x = $nope;');
    assert.ok(!fs.existsSync(path.join(dir, 'dist')), 'analyze writes nothing');

    const rel = await call('analyze', { overrides: [['channel', 'release']] });
    assert.ok(rel.result.inactive[rel.result.mainIdx].length > 0, 'release dims the dev-only lines');

    const inc = await call('resolveInclude', { spec: '/core/memory', from: main });
    assert.ok(inc.abs.endsWith(path.join('core', 'memory.ass')));
    assert.match((await call('resolveInclude', { spec: '../../x.ass', from: main })).error, /outside the source folder/);

    const built = await call('compile');
    assert.equal(built.error, undefined, built.error?.message);
    assert.ok(fs.existsSync(built.outFile));
    assert.ok(built.log.some((l: string) => /compiled/.test(l)));
    const line = fs.readFileSync(built.outFile, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('class GameMemory')) + 1;
    const w = await call('where', { line });
    assert.equal(w.rel, 'src/core/memory.ass');
    assert.deepEqual(await call('where', { line: 1 }), { generated: true });

    await assert.rejects(call('nope'), /unknown method/);
  } finally {
    child.kill();
  }
});

await Promise.all(results);
for (const d of temps) {
  // Drop the node_modules link first so cleanup can never reach into this repo's node_modules.
  const link = path.join(d, 'node_modules');
  try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still locked */ }
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
