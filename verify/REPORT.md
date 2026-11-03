# dsh-godot — independent end-to-end verification report

- **Date:** 2026-11-02 (Asia/Shanghai), final run after host-core's keepAlive/bridge fix.
- **Verdict:** **62 / 62 checks PASS**, exit code 0. One real functional defect was found and fixed
  during the session (keepAlive+bridge attach wait, §1 below); no open functional defects remain.
- **Verifier:** teammate `verifier` (independent; did not edit `godot-agent/**`, `demo/**`,
  `CONTRACT.md`; did not install the bundle; did not use `plugin_manager`).
- **Artifacts:** [`verify/e2e.mjs`](e2e.mjs) (suite, 62 checks),
  [`verify/harness-schema.mjs`](harness-schema.mjs) (loads the installed DSH JSON-Schema validator),
  [`verify/e2e-last-run.txt`](e2e-last-run.txt) (raw full output of the final run),
  `verify/tmp/e2e/**` (throwaway projects used by the run).

## 1. Exact command and result

```powershell
cd D:\DeepSeekHarness\plugins
node verify/e2e.mjs
# exit code 0
# SUMMARY passed=62 failed=0 total=62
# RESULT: ALL CHECKS PASSED
```

Reproduce with raw output captured:

```powershell
node verify/e2e.mjs 2>&1 | Tee-Object -FilePath verify\e2e-last-run.txt
```

Environment actually used: Windows, Node **v24.11.0** (task text said Node 22; this host has 24),
Godot **4.7.2.stable.official.ed1daf0bf** console build at
`D:\Software\Godot_v4.7.2-stable_win64.exe\Godot_v4.7.2-stable_win64_console.exe`,
no network. The plugin files at final run (sha256 prefixes):

| file | sha256(16) |
|---|---|
| `godot-agent/index.js` | `3FA5FFFC8459077C` |
| `godot-agent/src/tools.js` | `13AECF094E40C145` |
| `godot-agent/src/runner.js` | `C923C856059D4538` |
| `godot-agent/src/project.js` | `4F32DA93D4595681` |
| `godot-agent/src/bridge.js` | `99F1D39E5126DB22` |
| `godot-agent/src/engine.js` | `51D36147F0FA3FE3` |
| `godot-agent/src/gdparse.js` | `E013FBF11E04D14F` |
| `godot-agent/templates/bridge/dsh_bridge.gd` | `E68831C472755088` |

## 2. Verification boundary (what this suite does and does not exercise)

**Direct module coverage (not a live Harness install).** The suite imports `godot-agent/index.js`
and `godot-agent/src/*.js` through relative ESM paths and calls `apply(ctx, config)` with a fake
Cordis context that implements only `tools.register(def)` / `effect(fn, label)` (CONTRACT §1/§6).
Tools are invoked as raw `definition.execute(args)`. Nothing was installed into the live Harness:
no `plugin_manager`, no bundle installation, no Cordis/plugin-row load, no profile or
`cordis.patch.yml` execution, no writes under `~/.dsh`.

**Real external inputs.** Every engine operation uses the real Godot 4.7.2 console executable from
CONTRACT §0 (probe, import, `--check-only`, project/scene/script runs, bridge runs). The only
Harness artifact used is the **real installed** `@deepseek-ai/dsh-tools` JSON-Schema validator,
read out of Electron's packed `app.asar` by `verify/harness-schema.mjs`
(`dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js`, sha256
`912e04e68c2455cbb77651031449574f992720c90311e6cbecb1d35020bc1072`) and executed in-process with
two minimal stubs for its only imports (`HarnessError`, `assertNever`/`isJsonValue`). That exercises
the exact rule set registration applies via `assertSupportedJsonSchema(output.schema)`
(dsh-tools `lib/index.js:2978`), **but not** the Harness `ToolRuntime` registration/layers/
`schemaOf` model-facing projection.

**Not covered.** Actual bundle activation in DSH (cordis row load failure modes and HMR in a real
profile — cleanup is simulated by invoking the fake ctx disposers in reverse), the model-facing
schema projection performed by `ToolRuntime.schemaOf`, locale rendering in the GUI, PTC/TS SDK
renderers, windowed display paths (`headless:false` is not exercised; Godot runs `--headless`).

**Filesystem scope.** The suite writes only `verify/tmp/**`; the bridge test runs on a
byte-identical copy of `demo/` under `verify/tmp/e2e/demo`, and G4 asserts the real `demo/` tree is
unchanged. No temp project is created outside `verify/tmp`.

## 3. Pass/fail matrix (final run, 62 checks)

### A. Registration surface (15)
| ID | Check | Result |
|---|---|---|
| A1 | apply() registers exactly the six contract tools in order | PASS |
| A2 | every registration has name/description/parameters/output.schema/output.render/execute | PASS |
| A3 | parameters are plain JSON Schema (no inline required:true author spec) | PASS |
| A4-godot_status | output.schema of godot_status is accepted by DSH assertSupportedJsonSchema | PASS |
| A4-godot_project_init | output.schema of godot_project_init is accepted by DSH assertSupportedJsonSchema | PASS |
| A4-godot_check | output.schema of godot_check is accepted by DSH assertSupportedJsonSchema | PASS |
| A4-godot_run | output.schema of godot_run is accepted by DSH assertSupportedJsonSchema | PASS |
| A4-godot_bridge | output.schema of godot_bridge is accepted by DSH assertSupportedJsonSchema | PASS |
| A4-godot_stop | output.schema of godot_stop is accepted by DSH assertSupportedJsonSchema | PASS |
| A5 | fake ctx effect/disposer wiring covers 6 tools + unload cleanup | PASS |
| A6 | index.js exports apply + inject only (no export const Config, CONTRACT §1) | PASS |
| A7 | package.json declares the installable bundle metadata and no dependencies (CONTRACT §1, §7) | PASS |
| A8 | cordis.patch.yml inserts the dsh-godot row and documents the config keys | PASS |
| A9 | locale/en.json and locale/zh.json carry meta.title + meta.description (CONTRACT §7) | PASS |
| A10 | runtime sources import no harness packages and never shell-concatenate commands (CONTRACT §7) | PASS |

### B. Engine discovery and runner (6)
| ID | Check | Result |
|---|---|---|
| B1 | enginePath file resolves and probes Godot 4.7.2 console build | PASS |
| B2 | enginePath directory prefers the *_console.exe inside it | PASS |
| B3 | GUI executable path is switched to the sibling console build | PASS |
| B4 | no engine found -> actionable CONTRACT §5 message | PASS |
| B5 | GODOT_BIN environment variable is honoured (CONTRACT §5 step 2) | PASS |
| B6 | runner capture/session API works under the sandbox (file-capture fallback) and caps output at 200 KB | PASS |

### C. Fresh-project flow: init -> status -> check -> run -> stop (11)
| ID | Check | Result |
|---|---|---|
| C1 | godot_project_init scaffolds a complete runnable project and imports it | PASS |
| C2 | godot_status reports engine, projectRoot, configured project and no sessions | PASS |
| C3 | godot_check passes on the freshly scaffolded project (import + every script) | PASS |
| C4 | godot_run mode:"scene" captures a known print line and reports the real exit code | PASS |
| C5 | godot_run headless project captures STARTER_READY then times out and kills the process | PASS |
| C6 | godot_stop (no session) stops everything; status reports no sessions | PASS |
| C7 | godot_project_init refuses a non-empty directory with an actionable error | PASS |
| C8 | godot_project_init rejects an unknown template with an actionable error | PASS |
| C9 | godot_check accepts a project.godot path as `project` (CONTRACT §2) | PASS |
| C10 | godot_run mode:"script" runs a SceneTree script and reports its exit code | PASS |
| C11 | godot_run caps output at 200 KB and marks truncation (CONTRACT §2) | PASS |

### D. Bug injection: parse + runtime diagnostics (7)
| ID | Check | Result |
|---|---|---|
| D1 | godot_check reports the parse error with severity=error, res:// file and the exact line | PASS |
| D2 | parse diagnostics contain only contract fields and ignore engine noise (CONTRACT §3) | PASS |
| D3 | godot_run reports the runtime error with severity=error, res:// file, line and function | PASS |
| D4 | a script that prints then errors does not leak a process or a session | PASS |
| D5 | after fixing both scripts godot_check is ok again (default discovery) | PASS |
| D6 | gdparse maps res://, absolute paths, functions and warnings; strips banner + noise | PASS |
| D7 | script discovery caps at 40, skips .godot/ and normalises res:// paths (CONTRACT §2) | PASS |

### E. Runtime bridge over the real engine (13)
| ID | Check | Result |
|---|---|---|
| E1 | godot_run keepAlive+bridge attaches and returns a live session | PASS |
| E2 | bridge ping returns {pong:true, scene:res://main.tscn} | PASS |
| E3 | bridge tree exposes /root/Main and its scene children | PASS |
| E4 | bridge node returns JSON-safe properties and script/type metadata | PASS |
| E5 | bridge node_set writes a property and a following node read observes the change | PASS |
| E6 | bridge node_call invokes a game method and returns JSON-safe data | PASS |
| E7 | bridge frames waits for the requested number of frames | PASS |
| E8 | bridge action presses a real input action and rejects unknown actions | PASS |
| E9 | bridge screenshot explains the headless restriction (CONTRACT §4) | PASS |
| E10 | bridge unknown command returns {ok:false, error} instead of breaking the session | PASS |
| E11 | malformed session id produces an actionable Error (message, not a stack) | PASS |
| E12 | bridge quit shuts the game down cleanly | PASS |
| E13 | godot_stop removes the session and leaves no bridge session behind | PASS |

### F. Robustness (6)
| ID | Check | Result |
|---|---|---|
| F1 | godot_run on a nonexistent project gives an actionable error | PASS |
| F2 | missing required argument yields an actionable error | PASS |
| F3 | keepAlive without bridge runs and is stoppable; godot_bridge explains it has no bridge | PASS |
| F5 | keepAlive+bridge on a project without the bridge autoload returns ~1.5 s after output, not blocked 15 s | PASS |
| F6 | keepAlive+bridge with the autoload present but never connecting reports attached=false, timedOut=true and a hint | PASS |
| F4 | plugin unload (ctx.effect disposers) kills a live keepAlive session | PASS |

### G. Cleanup (4)
| ID | Check | Result |
|---|---|---|
| G1 | every Godot pid started by this suite is gone | PASS |
| G2 | no dsh-godot capture files for this process remain in the temp dir | PASS |
| G3 | no new Godot process is left running globally (beyond concurrent teammate work) | PASS |
| G4 | demo/ is byte-for-byte untouched by verification (bridge ran on a copy) | PASS |

## 4. Observed evidence (short)

- **A4** — installed validator, all six output schemas:
  `output.schema godot_run: PASS — installed harness (app.asar, sha256 912e04e68c24…)`.
- **A3** — plain JSON Schema, no inline `required:true` anywhere:
  `godot_run: 9 properties, required=["project"]`, `godot_bridge: 3 properties, required=["session","command"]`,
  `godot_status: 0 properties, required=[]`, `godot_stop: 1 properties, required=[]` (its only arg is optional).
- **C1** — `created 4 files, import exit 0` (project.godot, main.tscn, main.gd, addons/dsh_bridge/dsh_bridge.gd;
  template README not copied; autoload row `Bridge="*res://addons/dsh_bridge/dsh_bridge.gd"` asserted).
- **C4** — self-quitting scene: `godot_run: exitCode=3, output has EXIT_SCENE_READY`.
- **C5** — starter project: `timedOut=true, exitCode=undefined, pid gone`; output contained
  `STARTER_READY name=VerifyFresh scene=res://main.tscn`.
- **C11** — `204855 bytes returned, marker present` (`[dsh-godot: output truncated to the last 204800 bytes]`,
  tail `BIG_OUTPUT_END` kept).
- **D1** — real `--check-only` output parsed as:
  `{"severity":"error","message":"Parse Error: Expected expression for variable initial value after \"=\".",`
  `"file":"res://bugs/parse_bug.gd","line":4,"function":"GDScript::reload","source":"parse"}`.
- **D3** — real runtime error: `res://bugs/runtime_bug.gd:6 fn=_ready
  message=Out of bounds get index '5' (on base: 'Array')`, source `runtime`, print before the error
  (`RUNTIME_BUG_READY`) captured, then timeout kill and `sessions=[]`.
- **D5** — after the fix: `ok=true checked=7 diagnostics=0`.
- **E1** — `session=g6 pid=8588 port=51597`; command verified as
  `[...console.exe, --headless, --path, <demo copy>, --, --deterministic, --dsh-bridge=127.0.0.1:51597]`.
- **E5** — `game_over false -> true read back` via a following `node` request.
- **E6** — `node_call debug_state` returned
  `{"coins":5,"deterministic":true,"enemies":3,"game_over":true,...,"player_position":[400,520],"player_speed":260,"score":0}`.
- **E9** — screenshot under headless: `screenshot unavailable: running under the 'headless' display driver (headless); use a windowed run`.
- **E11** — bad session id: `Error: godot_bridge: unknown session "nope". Active sessions: g4. Start one with godot_run { keepAlive: true, bridge: true }.`
- **F5** — `returned in 1572 ms, attached=false, pid gone after stop` (was 15 083 ms before the fix).
- **F6** — `attached=false timedOut=true elapsed=5072 ms, hint in output`
  (`[dsh-godot] bridge did not attach within 5000 ms even though the dsh_bridge autoload is registered; ...`).
- **G1/G3/G4** — `8 tracked pid(s) gone`, `no Godot processes running (0 total)`, `16 demo entries unchanged`.

## 5. Defects and CONTRACT deviations

### 5.1 Real functional defect — FOUND, FIXED and re-verified during this session

**Defect:** a `godot_run { keepAlive: true, bridge: true }` call on a project that has no
`dsh_bridge` autoload blocked for the full attach budget (up to min(timeoutMs, 15000) ms) instead of
returning ~1.5 s after the first output as CONTRACT §2 requires ("keepAlive: true returns once
bridge attached (or ~1.5 s after first output)").

- **Symptom:** call took **15 083 ms**; contract/expected ~1.5–3 s. Reproduced with a scaffolded
  project whose `[autoload]`/`Bridge=` row was removed.
- **Reproduction:** `verify/e2e.mjs` check **F5** (fixture `verify/tmp/e2e/no-autoload`); prior code
  path was `godot-agent/src/tools.js` `godot_run` keepAlive branch (`waitForKeepAliveBridge`,
  tools.js:453–492 before the fix), which always awaited the attach deadline.
- **Expected vs actual:** expected `attached:false` after ~1.5 s + actionable hint;
  actual 15 083 ms block, no hint.
- **Disposition:** host-core added `projectHasBridgeAutoload()` (project.js:85) and
  `waitForKeepAliveRun()` (tools.js:518), which gates the attach-authoritative wait on the autoload
  and appends `BRIDGE_MISSING_AUTOLOAD_HINT` (tools.js:495). Re-verified: F5 PASS (1 572 ms) and the
  new F6 PASS (autoload present, never connects → `timedOut:true`, 5 072 ms, hint in output).
  This defect is **closed**.

### 5.2 Low-severity, still open (do not affect exit code)

1. **Cosmetic double period in missing-argument messages.**
   `godot_project_init: missing required argument "directory" — Directory to create the project in.
   Must be empty or not exist yet..` because `describeArgument` appends `" — " + description`
   (tools.js:96–97) and the message template appends another `.` (tools.js:158); the descriptions
   already end with `.` (e.g. tools.js:623, 664, 748). Observed in F2. Actionable despite the typo.
2. **CONTRACT §2 keyword list is stale, code is correct.** The contract forbids `oneOf` in
   `output.schema`; the implementation uses `oneOf` at tools.js:187, 201, 232. The **installed**
   harness explicitly supports `oneOf`/`const`/annotations (extracted
   `dsh-tools/lib/types/json-schema.js:6,28–39`) and all six schemas PASS the real
   `assertSupportedJsonSchema`. Recommendation: update CONTRACT §2, not the code.
3. **CONTRACT §6 internal-API naming mismatch.** §6 names `startSession({command,cwd,env})` and
   `stdout`/`stderr` ring buffers; `runner.js` exports `createSessionRegistry().start(...)`
   (runner.js:398) and `Session.readOutput()` (runner.js:255), with no `startSession` export and no
   `stdout`/`stderr` accessors. Functionally equivalent and covered by B6; documentation/API drift only.
4. **`godot_project_init { import:false }` reports `import: { ok: true, exitCode: null }` even
   though no import pass ran** (project.js:333–334). Misleading rather than wrong per contract; a model
   could read `ok:true` as "imported". Consider `null`/`skipped` semantics.
5. **Extension, not a defect (agreed with Lead):** on keepAlive+bridge attach-timeout the tool now
   appends a synthetic host hint line to `output` and sets `timedOut:true` for the *attach wait*
   (tools.js:495–500, 829–862) — `output` is documented as combined process stdout+stderr and
   `timedOut` as a process timeout (CONTRACT §2). Documented in the tool description; verified by F6.
6. **Ambiguity, not tested as a requirement:** CONTRACT §2 says `bridge:true` "waits for the game to
   attach", but a **non-keepAlive** bridge run waits for process exit and only reports
   `bridge.attached` as observed at exit (tools.js:881–899). This combination is not useful for
   `godot_bridge` (requires a live session) and no requirement was asserted on it.

## 6. Cleanup statement

Final run leaves: no Godot processes (G1/G3), no `dsh-godot-*.log` capture files for the suite's
process (G2), `demo/` unchanged (G4). All scratch projects live under `verify/tmp/e2e/**`
(`project`, `demo`, `no-autoload`, `bridge-inert`, `scripts-fixture`). The suite is re-runnable and
cleans `verify/tmp/e2e` at the start of each run.
