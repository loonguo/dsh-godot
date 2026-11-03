# dsh-godot contract (v1) — shared source of truth

Owner: Lead. Every teammate implements against this file; do not change a public name,
wire field, or file path without messaging the Lead first.

## 0. Environment facts (verified by Lead)

- Godot 4.7.2 editor build, console variant:
  `D:\Software\Godot_v4.7.2-stable_win64.exe\Godot_v4.7.2-stable_win64_console.exe`
  (same folder also holds `Godot_v4.7.2-stable_win64.exe`, the non-console build).
  Always invoke the `*_console.exe` when it exists — the non-console Windows build does
  not reliably deliver stdout/stderr to a pipe.
- Verified CLI behaviour (all with `--headless`):
  - import pass: `godot --headless --path <projDir> --quit` (exit 0; may emit non-fatal
    `ERROR: Could not create directory: 'user://logs'` when the parent process is sandboxed —
    ignore when it comes from our own sandbox, do not present it as a game error)
  - run once: `godot --headless --path <projDir> --quit-after <N>`
  - user args: everything after a bare `--` is visible to `OS.get_cmdline_user_args()`
  - script check: `godot --headless --path <projDir> --check-only --script res://x.gd`
    exits 1 and prints, on **stderr**:
    `SCRIPT ERROR: Parse Error: <message>.`
    `   at: GDScript::reload (res://broken.gd:4)`
  - runtime script error example:
    `SCRIPT ERROR: Invalid call. Nonexistent function 'foo' in base 'Node'.`
    `   at: <function> (res://main.gd:6)`
- No network access. Godot is already installed; do not try to download anything.
- Workspace root: `D:\DeepSeekHarness\plugins` (sandbox workspace-write).
- Node 22+ and pnpm are on PATH. Package is ESM (`"type": "module"`).

## 1. Deliverable layout

```
godot-agent/                     # ONE installable DSH bundle package
  package.json                   # @local/dsh-godot
  cordis.patch.yml               # inserts row id "dsh-godot"
  index.js                       # apply(ctx, config) -> registers 6 tools
  icon.svg
  locale/en.json  locale/zh.json # meta.title / meta.description
  src/engine.js                  # locate + probe engine
  src/runner.js                  # spawn/capture/timeout + session registry
  src/gdparse.js                 # Godot log -> structured diagnostics
  src/project.js                 # scaffold project from templates/
  src/bridge.js                  # NDJSON TCP client (host side of the bridge)
  src/tools.js                   # tool definitions (schemas + execute + render)
  templates/                     # copied verbatim into a new project
    project.godot.tmpl
    main.tscn.tmpl
    main.gd.tmpl
    bridge/dsh_bridge.gd         # runtime autoload bridge (GDScript)
  test/*.mjs                     # node-only unit tests, no cordis needed
demo/                            # verification game project (NOT shipped features)
verify/                          # end-to-end scripts + evidence
```

`index.js` exports `export const inject = ['tools']` and `export function apply(ctx, config)`.
There is **no** `export const Config` schema in v1 — `config` is a plain object merged over
defaults by the plugin itself, so unknown keys are tolerated. Document keys in the patch
comment: `enginePath`, `projectRoot`, `defaultTimeoutMs`.

## 2. Tool surface (model-facing names are exact)

All tools return a JSON value; `output.render` must return `[{ type: 'text', text }]` (confirmed
against `@deepseek-ai/dsh-tool-todo/lib/index.js`).

**Raw `ctx.tools.register()` stores `parameters` verbatim and projects it to the model
unchanged** (dsh-tools/lib/index.js:2974-2983, 3135-3145), so `parameters` must be plain JSON
Schema: `{ type: 'object', properties: { ... }, required: [...], additionalProperties: false }`.
Only `output.schema` is validated at registration by `assertSupportedJsonSchema`; use only the
keyword subset the installed todo tool uses there — `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum` (no `description`, `title`, `oneOf`, `default`,
`const`, `format`). Descriptions belong in `parameters`, which is not validated.

Raw registrations get no argument validation (that comes from `defineTool`, which we must not
import), so every `execute` validates its own required args and throws a plain `Error` with an
actionable message; unknown args are ignored. Return values must be lossless JSON and match the
declared `output.schema`; omit optional fields instead of returning `undefined`.

### `godot_status`
`{}` → `{ engine: { path, version, console: bool } | null, projectRoot, defaultTimeoutMs,
sessions: [{ id, pid, project, startedAt, bridge: { attached, port } | null, alive }] ,
project?: { path, name, mainScene, valid } }`

### `godot_project_init`
`{ directory: string, name?: string, template?: 'empty'|'2d', import?: boolean }`
Creates the directory (must be empty or absent), writes `project.godot`, `main.tscn`,
`main.gd`, `addons/dsh_bridge/dsh_bridge.gd` and the autoload row; runs an import pass
unless `import: false`. → `{ project, name, mainScene, files: string[], import:
{ ok, exitCode, diagnostics } }`

### `godot_check`
`{ project: string, scripts?: string[], import?: boolean }`
`project` accepts either the project directory or a `project.godot` path. With no
`scripts`, discovers up to 40 `*.gd` files under the project (skip `.godot/`), runs
`--check-only` per script; `import: true` (default) also runs the import pass once.
→ `{ ok: bool, diagnostics: Diagnostic[], checked: string[], import?: {...}, truncated?: bool }`

### `godot_run`
`{ project, mode?: 'project'|'scene'|'script', scene?: string, script?: string,
args?: string[], headless?: boolean, timeoutMs?: number, keepAlive?: boolean,
bridge?: boolean }`
- `headless` defaults to `true`.
- `bridge: true` additionally opens a loopback TCP server, appends
  `--dsh-bridge=127.0.0.1:<port>` (after `--`) and waits for the game to attach.
- `keepAlive: true` returns once bridge attached (or ~1.5 s after first output) and keeps
  the process running under a new `session` id. `keepAlive: false` waits for exit or
  `timeoutMs` (default 20000), then kills the process.
→ `{ session?: string, pid, command: string[], exitCode?: number|null, timedOut: bool,
bridge: { attached, port } | null, output: string, diagnostics: Diagnostic[] }`
`output` is the combined stdout+stderr tail, capped at 200 KB (mark truncation).

### `godot_bridge`
`{ session: string, command: string, args?: object }` → `{ ok, result?, error? }`
Commands implemented by the GDScript side: `ping`, `tree`, `node`, `node_set`,
`node_call`, `action`, `frames`, `screenshot`, `quit` (see §4).

### `godot_stop`
`{ session?: string }` — omit to stop all sessions → `{ stopped: string[] }`

## 3. Diagnostic shape (shared JS type)

```js
{ severity: 'error'|'warning', message: string, file?: string, line?: number,
  function?: string, source: 'parse'|'runtime'|'engine', raw: string }
```
`gdparse.js` exports `parseGodotLog(text) -> Diagnostic[]` and strips the header lines.
Parse `SCRIPT ERROR:`, `ERROR:`, `WARNING:` blocks with a following `at:` line; map
`res://` and absolute paths; `function` from `at: <fn> (res://f.gd:12)`.
Ignore engine noise: `Could not create directory: 'user://logs'`,
`Failed to open log file for writing`, `Failed to read the root certificate store`.

## 4. Bridge wire protocol (host ↔ game), NDJSON over TCP

Direction: the **game connects out** to the host listener, so no inbound firewall rule and
no port guessing. Listener binds `127.0.0.1` on an ephemeral port.

Game → host first line after connect (unsolicited event):
```json
{"event":"ready","engine":"4.7.2","project":"Game","scene":"res://main.tscn","pid":1234}
```

Request (host → game), one JSON object per `\n`:
```json
{"id":7,"cmd":"node","args":{"path":"/root/Main"}}
```
Response (game → host):
```json
{"id":7,"ok":true,"result":{}}
{"id":7,"ok":false,"error":"node not found: /root/Main"}
```
Unknown `cmd` → `ok:false`. A host request times out after 10 s (per request).

### Commands

| cmd | args | result |
|---|---|---|
| `ping` | `{}` | `{"pong":true,"scene":...}` |
| `tree` | `{depth?:number=4, includeInternal?:boolean=false}` | `{"root":{name,path,type,scene,children:[]}}` (`path` = NodePath from `/root`) |
| `node` | `{path:string, properties?:string[]}` | `{name,path,type,scene,script,properties:{...}}` JSON-safe values only, non-JSON values as `"<ClassName>"` |
| `node_set` | `{path,property,value}` | `{"value":<new json-safe value>}` |
| `node_call` | `{path,method,args?:array}` | `{"return":<json-safe>}` |
| `action` | `{action:string,pressed?:boolean=true}` | `{"pressed":...}` — uses `Input.action_press/release` |
| `frames` | `{count:number}` | `{"frames":n}` — respond after n processed frames |
| `screenshot` | `{path?:string}` | `{"path":"<absolute os path>","bytes":n}` — saves PNG of the root viewport; `ok:false` explaining "headless" when the display driver is dummy |
| `quit` | `{code?:number=0}` | `{}` then `get_tree().quit(code)` |

`dsh_bridge.gd` is an autoload `Node`. It does nothing unless `--dsh-bridge=<host>:<port>` is
present in `OS.get_cmdline_user_args()`. Use `StreamPeerTCP` + non-blocking `poll()` in
`_process`, buffer bytes, split on `\n`, `JSON.parse_string`, dispatch, reply. Never block a
frame. Close politely on `quit`.

## 5. Engine discovery order (`src/engine.js`)

1. config `enginePath` (file or directory) — if a directory, prefer `*_console.exe` inside.
2. env `GODOT_BIN`.
3. `godot`, `godot4`, `Godot` on PATH (via `child_process` spawn with `--version`).
4. Scan: `D:\Software\Godot*`, `C:\Program Files\Godot*`, `%LOCALAPPDATA%\Programs\Godot*`,
   `D:\Godot*`, `C:\Godot*` (bounded, depth ≤ 3, stop at first console exe).
If a resolved path is the GUI exe and a sibling `*_console.exe` exists, switch to it.
`probeEngine(path)` runs `--version`, returns `{ path, version, console }`.
Cache the successful probe; a failed spawn surface as an actionable error message:
"Godot engine not found. Install Godot 4.x and set `enginePath` in the `dsh-godot` row of
`cordis.patch.yml`, or set the GODOT_BIN environment variable."

## 6. Session model (`src/runner.js`)

- `startSession({ command, cwd, env }) -> Session` with `stdout`/`stderr` ring buffer
  (last 200 KB), `stop()`, `waitForExit(ms)`, `waitForOutput(regex, ms)`.
- Session ids: short random (`g1`, `g2`, ... or 6 hex chars, stable per process).
- All live sessions owned by the plugin `ctx.effect()` must be killed when the plugin
  unloads (HMR) — register the cleanup in `index.js`.
- Bridge listener lifecycle: created by `godot_run` when `bridge:true`, closed by
  `godot_stop` / process exit.
- `ctx.tools.register(...)` disposers are returned/cleaned through `ctx.effect`.

## 7. Rules

- No new npm dependencies. Node built-ins only (`node:child_process`, `node:net`,
  `node:fs`, `node:path`, `node:os`, `node:crypto`).
- Never `require` harness packages; the package owns no runtime deps.
- Windows-first, but build command arrays (`spawn(exe, argv, { shell: false })`), never
  shell-concatenated strings.
- Every tool must fail with an actionable message, not a stack trace.
- Display metadata: `locale/en.json` and `locale/zh.json` with `meta.title` and
  `meta.description` (Lead writes these).
- Do not install the bundle; only the Lead installs it.

## 8. Delivered implementation vs. this document (post-build notes)

The shipped code is the authority; where it differs from the text above, the difference was
verified against the real harness or engine and is intentional:

- `output.schema` may use `oneOf`/`const`/`description`/`title`/`default`/`examples`: the
  installed `@deepseek-ai/dsh-tools/lib/types/json-schema.js` accepts that keyword set, and all
  six shipped schemas pass the real `assertSupportedJsonSchema` (checked by verify/harness-schema.mjs).
- §6 names `startSession` + `stdout`/`stderr`; the shipped runner exposes
  `createSessionRegistry().start()` + `Session.readOutput()` (same semantics, 200 KB combined tail).
- §4's `tree` depth is descendant levels below `/root`: depth 1 = direct children, depth 2 also
  their children; documented in the tool description.
- `godot_run {keepAlive:true, bridge:true}` is attach-authoritative when the project has the
  `dsh_bridge` autoload, and returns ~1.5 s after output with `attached:false` + a hint when it
  does not (so a bridge-less project never burns the 15 s attach budget).
- Known cosmetic issues left in place: missing-argument errors end with a double period, and
  `godot_project_init {import:false}` still reports `import.ok: true`.
