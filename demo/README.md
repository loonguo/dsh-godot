# BridgeDemo — verification game for dsh-godot

A small, readable 2D game that exists to prove the dsh-godot loop end to end:
scaffold a project, check GDScript, run it headless, drive it through the
loopback bridge (`CONTRACT.md` §4) and assert behaviour deterministically.

## Play it

```powershell
godot --path demo                 # windowed, playable
```

- Arrow keys / WASD: move the blue triangle.
- Yellow diamonds: +1 score. Red squares: lose a life (3 lives).
- R restarts after game over.

## Files (what an agent edits)

| File | Purpose |
|---|---|
| `main.gd` | Game controller: score/lives, starting layout (`INITIAL_COINS`, `INITIAL_ENEMIES`), spawn pacing, HUD, `debug_state()`, `spawn_coin()`, `spawn_enemy()`, `apply_damage()`. **Edit here for rules/balance.** |
| `main.tscn` | Scene tree: `Main` → `Background`, `Coins`, `Enemies`, `Player`, `HUD` (`Status`, `GameOver`, `Hint`). |
| `player.gd` / `player.tscn` | Movement (`@export speed`), invulnerability, `dsh_probe()`; root is in the `player` group. |
| `coin.gd` / `coin.tscn` | Collectible `Area2D`, emits `collected`. |
| `enemy.gd` / `enemy.tscn` | Hazard `Area2D`, bounces in the arena, emits `touched`. |
| `tests/headless_test.gd` | Autoload `HeadlessTest`; deterministic PASS/FAIL suite, runs only with `--test`. |
| `addons/dsh_bridge/dsh_bridge.gd` | Runtime bridge autoload (copy of `godot-agent/templates/bridge/dsh_bridge.gd`; keep in sync). |
| `evidence/` | Generated screenshots/transcripts (gitignored), not part of the game. |

## Run it headless

```powershell
# 1. import pass (first run, exit 0)
godot --headless --path demo --quit

# 2. boot check: expect "DEMO_READY coins=5 enemies=3 deterministic=false"
godot --headless --path demo --quit-after 30

# 3. deterministic test suite: 21 assertions, expect "TEST SUMMARY passed=21 failed=0", exit 0
godot --headless --path demo -- --test

# 4. per-script syntax/type check
godot --headless --path demo --check-only --script res://main.gd
```

`--test` also disables the spawn timers (`main.deterministic == true`), so the
initial 5 coins / 3 enemies stay stable while the suite teleports the player,
collects a coin and takes a hit. Both `--test` and `--deterministic` accept
`--fixed-fps 60` before the bare `--` for fully repeatable frames.

## Drive it over the bridge

The game only opens a socket when `--dsh-bridge=host:port` is passed **after**
`--`:

```powershell
godot --headless --fixed-fps 60 --path demo -- --deterministic --dsh-bridge=127.0.0.1:49152
```

A host-side harness equivalent to `godot_run {bridge:true}` + `godot_bridge`:

| Wire request | Why |
|---|---|
| `{"id":1,"cmd":"ping"}` | `{"pong":true,"scene":"res://main.tscn"}` |
| `{"id":2,"cmd":"tree","args":{"depth":3}}` | see `/root/Main/Player`, `/root/Main/Coins/Coin2`, ... |
| `{"id":3,"cmd":"node","args":{"path":"/root/Main/Player","properties":["speed","position"]}}` | `speed`: JSON number, `position`: `"<Vector2>"` |
| `{"id":4,"cmd":"node_call","args":{"path":"/root/Main","method":"debug_state"}}` | score/lives/coins/enemies/player_position |
| `{"id":5,"cmd":"node_set","args":{"path":"/root/Main/Player","property":"speed","value":400}}` | `{"value":400}` |
| `{"id":6,"cmd":"node_set","args":{"path":"/root/Main/Player","property":"position","value":[180,140]}}` | `[x,y]` is coerced to `Vector2`; player then touches `Coin` |
| `{"id":7,"cmd":"action","args":{"action":"ui_right","pressed":true}}` | press a real InputMap action |
| `{"id":8,"cmd":"frames","args":{"count":20}}` | answer after 20 frames; during them `_physics_process` moved the player |
| `{"id":9,"cmd":"node_call","args":{"path":"/root/Main","method":"spawn_coin","args":[700.0,60.0]}}` | returns `"<Area2D>"` |
| `{"id":10,"cmd":"screenshot","args":{"path":"demo/evidence/shot.png"}}` | windowed only; headless returns `ok:false` explaining "headless". Omit `path` to write `res://dsh_screenshot.png` (inside the project dir) |
| `{"id":11,"cmd":"quit","args":{"code":0}}` | replies `{}` then exits |

Notes for agents:

- `node_set` / `node_call` arguments are JSON: numbers, strings, bools and
  arrays of those. `Vector2`/`Color` come back as `"<Vector2>"` / `"<Color>"`.
  Use the helper methods (`debug_state`, `dsh_probe`) or `[x, y]` for positions
  instead of guessing property types.
- `frames` is the reliable way to "wait a few ticks": it counts *processed*
  frames, so it is unaffected by `--fixed-fps` speed-ups.
- Unknown node paths/methods/actions produce `ok:false` with a readable
  `error` (e.g. `node not found: /root/Main/Nope`) — check that first.
- Screenshots need a real display server; under `--headless` the bridge
  correctly answers `ok:false` with a message mentioning headless.

## How an agent should debug this game (typical loop)

1. Read `main.gd` (rules) and the actor scripts; edit the relevant file.
2. `godot --headless --path demo --check-only --script res://<changed>.gd`
   — fix any `SCRIPT ERROR:` parse diagnostics before running.
3. `godot --headless --fixed-fps 60 --path demo -- --test` — assert invariants
   still hold (PASS/FAIL lines).
4. Start a kept-alive bridge run (`--deterministic` for stable counts), then
   use `tree` / `node` to inspect live state, `node_set` to change a value,
   `action`+`frames` to simulate input, `node_call debug_state` to verify the
   effect, `screenshot` for visual proof, `quit` to end it.
5. Read the tail of the game's stdout for `[demo] ...` and `DEMO_READY ...`
   lines; parse `SCRIPT ERROR:` / `ERROR:` blocks for diagnostics.

## Deterministic test output (reference)

```
DEMO_READY coins=5 enemies=3 deterministic=true
PASS main scene loaded
PASS player instantiated in the player group
...
PASS last life ends the game
TEST SUMMARY passed=21 failed=0
```
