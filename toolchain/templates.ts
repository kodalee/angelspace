// New-project scaffolding (`npm run create`): the files a fresh project adds to the repo root —
// angelspace.yaml, src/ and .vscode/. package.json, README.md and .gitignore belong to the repo.

export interface ScaffoldOptions {
  name: string;
  /** process to attach to, e.g. game.exe */
  target: string;
  /** main module to resolve, e.g. client.dll (blank = the exe itself) */
  module: string;
  template: 'starter' | 'minimal';
}

export const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'project';

const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';

export function scaffold(o: ScaffoldOptions): Record<string, string> {
  const id = slug(o.name);
  const mod = o.module.trim() || o.target;
  const files: Record<string, string> = {
    'angelspace.yaml': yaml(o, id),
    '.vscode/settings.json': json({
      'files.associations': { '*.ass': 'angelspace' },
      '[angelspace]': { 'editor.tabSize': 4, 'editor.insertSpaces': true },
      'files.exclude': { 'dist/*.map.json': true },
    }),
    '.vscode/tasks.json': json({
      version: '2.0.0',
      tasks: [
        { type: 'npm', script: 'build', label: 'angelspace: build', group: { kind: 'build', isDefault: true }, problemMatcher: [] },
        { type: 'npm', script: 'build:install', label: 'angelspace: build & install', group: 'build', problemMatcher: [] },
        { type: 'npm', script: 'watch', label: 'angelspace: watch', isBackground: true, problemMatcher: [] },
      ],
    }),
    '.vscode/extensions.json': json({ recommendations: ['koda.angelspace-vscode', 'redhat.vscode-yaml'] }),
  };
  if (o.template === 'minimal') {
    files['src/main.ass'] = minimalMain();
  } else {
    files['src/config.ass'] = starterConfig(o, mod);
    files['src/core/memory.ass'] = starterMemory();
    files['src/ui/menu.ass'] = starterMenu(id);
    files['src/features/overlay.ass'] = starterOverlay();
    files['src/main.ass'] = starterMain();
  }
  return files;
}

const yaml = (o: ScaffoldOptions, id: string) => `# AngelSpace project. Docs: hover anything, or run "AngelSpace: Search Angel API".
name: ${id}
target: ${o.target}

src: src
main: main.ass

# Pre-compile variables: #[name] (raw text) and $name (ready-made literal) in .ass files,
# and conditions like #[if channel == "dev"] ... #[endif].
defines:
  version: "0.1.0"
  channel: dev

output:
  dir: dist
  file: "#[projectName].as"
  lineEndings: crlf
  fileHeaders: true
  lineMap: true
  watermark:
    enabled: true
    lines:
      - "Compiled with AngelSpace by Koda | Compiled at #[compileTime] / #[compileEpoch]"
      - "#[projectName] #[version] (#[channel]) | target #[target] | build #[buildHash]"

install:
  enabled: false
  dir: \${APPDATA}/scripts
  overwrite: false

log:
  level: verbose
`;

const minimalMain = () => `// Entry point. Pull other modules in with #[include "/folder/file.ass"].

void on_unload() {
}

bool main() {
    console::log("[#[projectName]] v#[version] (#[channel]) built " + $compileTime);
    return true;
}
`;

const starterConfig = (o: ScaffoldOptions, mod: string) => `namespace Config {
    const string Process = $target;          // from angelspace.yaml
    const string Module = ${JSON.stringify(mod)};
    const int UpdateHz = 64;                 // update thread ticks per second
}
`;

const starterMemory = () => `#[include "/config.ass"]

// Owns the attachment to the target process.
class GameMemory {
    uint64 base = 0;
    string failure;

    bool attach() {
        auto info = process::attach(Config::Process);
        if (info.pid == 0) { failure = Config::Process + " not found, waiting for it"; return false; }
        base = process::get_module_base(Config::Module);
        if (base == 0) { failure = Config::Module + " not loaded yet"; return false; }
        failure = "";
        return true;
    }

    bool alive() { return process::is_alive(); }

    uint64 u64(uint64 address) { return process::read_uint64(address); }
    uint32 u32(uint64 address) { return process::read_uint32(address); }
    float f32(uint64 address) { return process::read_float(address); }
}
`;

const starterMenu = (id: string) => `// Menu definition. Values are read with ui::get(...) every tick.
class Menu {
    checkbox enabled;
    checkbox show_status;
    color_picker text_color;

    void build() {
        ui::config_path(${JSON.stringify(id)});
        ui::add_tab(${JSON.stringify(id)});
        ui::add_subtab("General");
        ui::add_category("Overlay", category_pos::left_top);
        enabled     = ui::add_checkbox("Enabled", true, "enabled");
        show_status = ui::add_checkbox("Show status", true, "show_status");
        text_color  = ui::add_color_picker("Text color", 255, 255, 255, 255, true, "text_color");
    }
}
`;

const starterOverlay = () => `#[include "/core/memory.ass"]
#[include "/ui/menu.ass"]

// Draws a small status line. Replace with your ESP / HUD.
class Overlay {
    void render(GameMemory@ mem, Menu@ menu) {
        if (!ui::get(menu.enabled) || !ui::get(menu.show_status)) return;
        color c = ui::get(menu.text_color);
        string status = mem.failure.isEmpty()
            ? Config::Process + " attached, base " + mem.base
            : mem.failure;
        render::draw_text_outlined(20, 20, "#[projectName] #[version] | " + status, c.r, c.g, c.b, c.a);
        #[if channel == "dev"]
        render::draw_text_outlined(20, 36, "dev build #[compileTime]", 160, 160, 160, 200);
        #[endif]
    }
}
`;

const starterMain = () => `#[include "/config.ass"]
#[include "/core/memory.ass"]
#[include "/ui/menu.ass"]
#[include "/features/overlay.ass"]

GameMemory@ g_mem;
Menu@ g_menu;
Overlay@ g_overlay;
bool g_attached = false;

void update_tick() {
    if (!g_attached || !g_mem.alive()) g_attached = g_mem.attach();
}

void render_tick() {
    g_overlay.render(g_mem, g_menu);
}

void on_unload() {
}

bool main() {
    #[if channel == "dev"]
    console::log("[#[projectName]] v#[version] dev build " + $compileTime);
    #[endif]
    @g_mem = GameMemory();
    @g_menu = Menu();
    @g_overlay = Overlay();
    g_menu.build();
    g_attached = g_mem.attach();
    create_thread(Config::UpdateHz, @update_tick);
    on_render(@render_tick);
    return true;
}
`;
