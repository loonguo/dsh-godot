# dsh-godot project templates

`godot_project_init` copies this directory into a new Godot 4 project. v1 ships a
single **2D starter**; the `template: 'empty' | '2d'` option of the tool both
resolve to this starter (an `empty` variant can be added later as `templates/empty/`).

## Placeholders

Plain text substitution (no templating engine), applied to the contents of the
files ending in `.tmpl`:

| Placeholder | Replaced with | Used in |
|---|---|---|
| `{{NAME}}` | project display name, e.g. `MyGame` | `project.godot` (`config/name`), `main.tscn` label, `main.gd` |
| `{{MAIN_SCENE}}` | `res://main.tscn` | `project.godot` (`run/main_scene`) |
| `{{BRIDGE_PATH}}` | `res://addons/dsh_bridge/dsh_bridge.gd` | `project.godot` (`[autoload] Bridge`) |

## File map

| Source | Destination in the new project |
|---|---|
| `project.godot.tmpl` | `project.godot` |
| `main.tscn.tmpl` | `main.tscn` |
| `main.gd.tmpl` | `main.gd` |
| `bridge/dsh_bridge.gd` | `addons/dsh_bridge/dsh_bridge.gd` (copied verbatim) |
| `README.md` (this file) | **not copied** — template documentation only |

Files under `templates/` ending in `.tmpl` are copied with the `.tmpl` suffix
stripped; any other file is copied verbatim. `README.md` is documentation-only
and must be skipped by the scaffolder.

## Expected scaffold result

```
project.godot      autoload Bridge="*res://addons/dsh_bridge/dsh_bridge.gd"
main.tscn          Node2D "Main" + Label/Hint/Marker, script res://main.gd
main.gd            prints one deterministic STARTER_READY line, has dsh_probe()
addons/dsh_bridge/dsh_bridge.gd
```

Check it without a window:

```powershell
godot --headless --path <proj> --quit                 # import pass, exit 0
godot --headless --path <proj> --quit-after 5         # expect stdout: STARTER_READY name=... scene=res://main.tscn
godot --headless --path <proj> --check-only --script res://main.gd
godot --headless --path <proj> --check-only --script res://addons/dsh_bridge/dsh_bridge.gd
```

The bridge only activates with user args after a bare `--`:

```powershell
godot --headless --path <proj> -- --dsh-bridge=127.0.0.1:49152
```

then the host can send `{"id":1,"cmd":"ping"}` and expects
`{"id":1,"ok":true,"result":{"pong":true,"scene":"res://main.tscn"}}`.

`screenshot` only works with a real display driver; with no `path` argument it
writes `res://dsh_screenshot.png` (inside the project folder).
