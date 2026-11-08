<h1 align="center">AngelSpace</h1>

<p align="center">Your workspace for AngelScript / <a href="https://echo-23.gitbook.io/angel">ech0</a> scripts.

---

Angel loads exactly one `.as` (**a**ngel-**s**cript) file per script. This can make it harder to maintain, read, and collaborate on your script. AngelSpace changes that by giving you a workspace to write as many `.ass` files and compiles them into that single `.as` file:

```c
#[include "config.ass"]

bool main() {
    #[if channel == "beta"]
      console::log($version + " beta, built #[compileTime]");
      console::log(Config::Woah);
    #[endif]
    return true;
}
```

```sh
npm run build          # → dist/my_script.as, ready for Angel
```

This repository **is** your workspace. Clone it, run `npm run create`, and write your script in
`src/` — the compiler (`toolchain/`) comes with it, and every command is an npm script.

| Repository | |
|---|---|
| [kodalee/angelspace](https://github.com/kodalee/angelspace) | **this repo** — clone it and work in it |
| [kodalee/create-angelspace](https://github.com/kodalee/create-angelspace) | `npx create-angelspace@latest` — an optional one-liner that does the clone + create for you |

## Contents

- [Getting started](#getting-started)
- [Project layout](#project-layout)
- [Commands](#commands) — everything you run, all through npm
- [Language reference](#language-reference) — includes, conditionals, variables
- [angelspace.yaml reference](#angelspaceyaml-reference)
- [The compiled output](#the-compiled-output)
- [Editor protocol](#editor-protocol)
- [Developing the toolchain](#developing-the-toolchain)
- [For AI assistants](#for-ai-assistants)

## Getting started

You need [Node.js](https://nodejs.org) **22.18 or newer** (the toolchain is TypeScript that Node runs
directly, no build step) and [Git](https://git-scm.com). Angel loads scripts from `%APPDATA%\scripts`.

```sh
git clone https://github.com/kodalee/angelspace my_script
cd my_script
npm install
npm run create            # starts a new project in this folder: angelspace.yaml + src/
npm run build             # → dist/my_script.as
npm run build:install     # build and copy into the Angel scripts folder
```

`npm run create` tells you what it's about to add to the folder, asks for the project name, the exe
Angel attaches to, the main module and a template (`starter` or `minimal`), and confirms before writing
anything. It never overwrites a file that already exists. Pass answers as options to skip the
questions: `npm run create -- --name my_script --target game.exe --template minimal --yes`.

Then reopen the Angel menu so it picks up the new script. For editor support install the
**AngelSpace** VS Code extension and open the folder.

## Project layout

```
my_script/
  toolchain/             the AngelSpace compiler and CLI (TypeScript, run directly by Node)
    test/                the toolchain's own tests
  src/                   your code                                    ┐
    main.ass             entry point: everything is reached from      │
    config.ass           its #[include]s                              │ added by
    core/memory.ass                                                   │ npm run create
    ...                                                               │
  angelspace.yaml        project config (name, target, variables…)    │
  .vscode/               file association, build tasks (Ctrl+Shift+B) ┘
  dist/                  the compiled script (git-ignored)
    my_script.as           what Angel loads
    my_script.as.map.json  line map: compiled line → .ass file:line
  package.json           every command (below)
  README.md, llms.txt    docs
```

The toolchain always works on the folder it sits in: the `angelspace.yaml` and `src/` next to
`toolchain/`. Until you run `npm run create` there's no project, and the other commands say so.

## Commands

Everything is an npm script in `package.json`, run from the repo root — in a terminal, or from the
VS Code extension (which runs the same toolchain).

| Command | |
|---|---|
| `npm run create` | start a new project in this folder (`angelspace.yaml`, `src/`, `.vscode/`) |
| `npm run build` | compile `src/` into `dist/` |
| `npm run build:install` | compile and copy into Angel's scripts folder |
| `npm run watch` | compile, then recompile on every change |
| `npm run where -- <line>...` | map compiled line numbers (e.g. from an Angel error) back to `.ass` file:line |
| `npm run vars` | list every pre-compile variable, its origin, type and value |
| `npm run help` | every command and option |
| `npm run angelspace -- version` | the toolchain's version |

Options go after `--`, and work with `build`, `build:install`, `watch`, `where` and `vars`:

```
npm run build -- -D channel=release --no-watermark

  -D, --define <name=value>      set/override a variable (repeatable; also -Dname=value)
      --install                  copy the output into the Angel scripts folder
      --force                    let --install overwrite a script AngelSpace didn't write
      --no-watermark             omit the watermark
      --no-headers               omit the per-file "referenced by" headers
  -c, --config <file>            config (default: the angelspace.yaml in the repo root)
  -q, --quiet                    errors and warnings only
  -v, --verbose                  verbose (default; shows the include tree as it parses)
      --debug                    everything, including each injection and timings
      --no-color                 plain output
```

`npm run create` takes `--name <name>`, `--target <exe>`, `--module <dll>`, `--template starter|minimal`
and `--yes` (ask nothing).

Exit code is `0` on success, `1` on a build error, `2` on bad arguments. Every script is
`node toolchain/cli.ts <command>`; Bun works too (`bun toolchain/cli.ts compile`). The one command
that isn't a script is `serve`, the [editor protocol](#editor-protocol) the VS Code extension starts.

To update the toolchain, pull this repo's latest commits (`git pull` from the upstream remote) —
your `src/` and `angelspace.yaml` aren't part of the upstream repo, so they don't conflict.

## Language reference

`.ass` files are AngelScript plus AngelSpace directives. Everything AngelSpace adds lives in
`#[ ... ]` or starts with `$`, and none of it reaches the output.

### Includes

```cpp
#[include "/sdk/bones.ass"]      // "/" = the src/ folder
#[include "../sdk/bones.ass"]    // relative to the file this line is in
#[include "helpers.ass"]         // same folder
```

- Each file is emitted **once**, at its first include. Later includes of it are skipped.
- Includes expand depth-first where they appear, so a file's dependencies always land above it and
  `main.ass`'s own code lands at the bottom. Nothing needs a forward reference.
- Circular includes (A → B → A) are skipped and logged. AngelScript resolves global names module-wide,
  so mutually referencing types still compile.
- `"x.as"` falls back to `x.ass`; `"x"` (no extension) tries `x.ass`.
- Includes can't leave `src/`. Any `.ass` file that nothing includes gets a warning.

### Conditionals

```cpp
#[if channel == "beta"] beta_only(); #[endif]       // inline

#[ifn something]                                     // "if not"
    a();
#[elif version >= 2.0]                               // also #[elifn ...]
    b();
#[else]
    c();
#[endif]
```

| Expressions | |
|---|---|
| Operators | `==` `!=` `<` `<=` `>` `>=` `&&` `\|\|` `!` `( )` |
| Literals | `"text"` `'text'` `1.0` `0x10` `true` `false` `null` |
| Functions | `defined(name)` |
| Comparison | numbers numerically; version strings part by part (`"1.10" > "1.9"`); a number vs a string by its exact spelling |

Branches that aren't taken are never evaluated, so they can reference undefined variables.
A directive alone on its line removes the whole line, leaving no blank line behind.

`#[error "message"]` stops the build. `#[warn "message"]` and `#[info "message"]` log and continue.

### Variables

Define them in `angelspace.yaml` under `defines:`, override with `-D name=value` or in VS Code.

| Syntax | `version: "1.0"` becomes | Use it for |
|---|---|---|
| `#[version]` | `1.0` | raw text: inside strings, comments, identifiers |
| `$version` | `"1.0"` | a ready literal: strings quoted and escaped, numbers and bools as-is, lists as `{a, b}`, null as `null` |

```cpp
console::log("#[version]");   // console::log("1.0");
console::log($version);       // console::log("1.0");
bool beta = $something;       // bool beta = false;
array<int> ids = $ids;        // array<int> ids = {1, 2, 3};
```

Numbers keep their spelling: `1.0` stays `1.0` and `0x10` stays `0x10`.

**Where directives work**

| Context | `#[name]` | `#[if]`… | `#[include]`, `#[error]`… | `$name` |
|---|---|---|---|---|
| code | ✓ | ✓ | ✓ | ✓ |
| strings | ✓ | ✓ | ✗ (error) | literal `$` |
| comments | ✓ known names only | inert | inert | literal `$` |

Commented-out directives do nothing, so `// #[include "x.ass"]` is a disabled include.
Escapes: `\#[` gives a literal `#[`; `$$` gives a literal `$`.

**Built-in variables**

| Name | Example |
|---|---|
| `angelSpaceVersion` | `"0.1.0"` |
| `compileEpoch` / `compileEpochMs` | `1793859888` (honors `SOURCE_DATE_EPOCH`) |
| `compileTime` / `compileDate` | `"2026-11-05T06:24:48Z"` / `"2026-11-05"` |
| `projectName`, `target`, `mainFile` | from `angelspace.yaml` |
| `runtime`, `runtimeVersion`, `hostOS` | `"node"`, `"24.19.0"`, `"win32"` |
| `__FILE__`, `__LINE__` | the current source file (relative to `src/`) and line, per use |
| `fileCount`, `lineCount`, `buildHash`, `outputFile` | **watermark lines only** |

## angelspace.yaml reference

```yaml
name: my_script            # → #[projectName]
target: game.exe           # → #[target]
src: src                   # source folder; "/" in includes
main: main.ass             # entry, relative to src

defines:                   # your variables: strings, numbers, bools, null, lists
  version: "1.0"
  channel: beta
  something: false

output:
  dir: dist                       # supports ${ENV_VARS}
  file: "#[projectName].as"       # template, e.g. "#[projectName]-#[channel].as"
  lineEndings: crlf               # crlf | lf
  fileHeaders: true               # "// x.ass referenced by ..." before each file
  lineMap: true                   # dist/<file>.map.json for `where` / F12
  watermark:
    enabled: true
    lines:
      - "Compiled with AngelSpace by Koda | Compiled at #[compileTime] / #[compileEpoch]"

install:
  enabled: false                  # or --install / "Compile & Install"
  dir: ${APPDATA}/scripts         # the Angel scripts folder
  overwrite: false                # true = may replace scripts AngelSpace didn't write

log:
  level: verbose                  # silent | error | warn | info | verbose | debug
```

Unknown keys are reported. Variable names can't be directive words (`if`, `include`, `defined`, …).

## The compiled output

```cpp
// Compiled with AngelSpace by Koda | Compiled at 2026-11-05T06:45:51Z / 1793861151
// my_script 1.0 (beta) | target game.exe | build 8a25805dae0e

// config.ass referenced by:
//   core/memory.ass:1
//   main.ass:1
namespace Config {
...
// core/memory.ass referenced by main.ass:2
class GameMemory {
...
// main.ass (main)
bool main() {
```

When Angel reports an error at a line of the compiled file, run `npm run where -- <line>`
(or press F12 on that line in VS Code) to get the `.ass` file and line.

`--install` won't overwrite a script in the Angel folder unless AngelSpace wrote it (its first line
has the watermark), or you pass `--force` / set `install.overwrite: true`.

## Editor protocol

The `serve` command is how editors use the toolchain. The VS Code extension starts it in the repo
root (`node toolchain/cli.ts serve`) and never compiles anything itself, so what the editor shows
is exactly what `npm run build` does. The wire format is one JSON object per line on stdin/stdout:

```jsonc
→ {"id": 1, "method": "analyze", "params": {"overrides": [["channel", "release"]], "overlays": {"C:/p/src/main.ass": "unsaved text"}}}
← {"id": 1, "result": {"project": {...}, "result": {...}, "diagnostics": [...]}}
```

| Method | |
|---|---|
| `hello` | protocol number (currently `1`), system version, project root |
| `analyze` | build in memory (nothing written): variables, files, build order, includes, inactive `#[if]` lines, diagnostics |
| `compile` | build and write `dist/` (optionally install); returns the snapshot plus the build log |
| `resolveInclude` | where an `#[include "…"]` path points |
| `where` | which `.ass` line a compiled line came from |
| `shutdown` | exit |

The types are in [`toolchain/serve.ts`](toolchain/serve.ts). `PROTOCOL` is bumped on incompatible changes; the extension
tells you to update whichever side is older.

## Developing the toolchain

The toolchain is the TypeScript in `toolchain/`; there's no build step, Node runs those files directly.
Edit them in place and run your project's commands to try the change.

```sh
npm run typecheck
npm test                 # templates, compiler, the CLI in a scratch clone, and the serve protocol
```

The tests (`toolchain/test/test.ts`) copy the repo into a temp folder without your `src/` or
`angelspace.yaml`, run `create` there, and build it — so they never touch your own project. CI runs
both commands on Windows and Linux.

| File (in `toolchain/`) | |
|---|---|
| `cli.ts` | command line, argument parsing, `create` |
| `project.ts` | load + build (the library entry point) |
| `config.ts` | `angelspace.yaml`, and where the project is (`PROJECT_ROOT`: the folder `toolchain/` sits in) |
| `compiler.ts` | lexer-aware preprocessor, include graph |
| `expr.ts` | `#[if]` conditions |
| `output.ts` | headers, watermark, line map, install |
| `serve.ts` | the editor protocol |
| `templates.ts` | what `npm run create` writes |
| `values.ts`, `builtins.ts`, `log.ts` | variables, built-in variables, logging |

## For AI assistants

[`llms.txt`](llms.txt) describes the whole system (syntax, semantics, config, commands, extension and
output format) in one file — point your assistant at it before asking for AngelSpace code.
