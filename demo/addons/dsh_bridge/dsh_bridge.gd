extends Node
## dsh_bridge.gd — runtime bridge for the dsh-godot DSH plugin.
##
## Wire protocol: CONTRACT.md §4 — newline-delimited JSON over TCP. The GAME
## connects OUT to the host listener given as `--dsh-bridge=<host>:<port>` after
## a bare `--` (i.e. it is a user arg, not a Godot CLI flag):
##
##     godot --headless --path <proj> -- --dsh-bridge=127.0.0.1:49152
##
## The node is completely inert (no socket, no processing) without that arg.
## Everything is non-blocking: `StreamPeerTCP.poll()` + partial reads inside
## `_process`; no frame is ever blocked waiting on the network.
##
## Wire format (exact):
##   game -> host (unsolicited, first line): {"event":"ready","engine":"4.7.2",
##       "project":"Game","scene":"res://main.tscn","pid":1234}
##   host -> game: {"id":7,"cmd":"node","args":{"path":"/root/Main"}}
##   game -> host: {"id":7,"ok":true,"result":{...}}
##                 {"id":7,"ok":false,"error":"node not found: /root/Main"}
##
## This file is copied verbatim to res://addons/dsh_bridge/dsh_bridge.gd and
## registered as an autoload by the dsh-godot project templates.

const BRIDGE_ARG := "--dsh-bridge="
## How often to retry while the host listener is not reachable yet.
const CONNECT_RETRY_MS := 250
## Give up connecting after this many ms (the host normally listens first).
const CONNECT_GIVE_UP_MS := 15000
## Hard cap for the unparsed input buffer (protects against a runaway peer).
const MAX_BUFFER_BYTES := 4 * 1024 * 1024
## Editor-visible properties returned by `node` when no explicit list is given.
const MAX_AUTO_PROPERTIES := 128

enum Phase { IDLE, CONNECTING, CONNECTED, DEAD }

var _phase: int = Phase.IDLE
var _host := ""
var _port := 0
var _tcp: StreamPeerTCP = null
var _retry_at_ms := 0
var _give_up_at_ms := 0
var _buffer := PackedByteArray()
## Pending `frames` requests: [{ "id": int, "remaining": int, "count": int }]
var _frame_requests: Array[Dictionary] = []
## Frames to wait before announcing `ready` (lets the main scene come up first).
var _announce_in := -1
## -1 = not quitting; otherwise frames left before `get_tree().quit()`.
var _quit_in := -1
var _quit_code := 0


func _ready() -> void:
	# Keep serving bridge commands while the game is paused (toolbar pause button).
	process_mode = Node.PROCESS_MODE_ALWAYS
	var parsed := _parse_bridge_arg(OS.get_cmdline_user_args())
	if parsed.is_empty():
		# No bridge requested: stay completely inert.
		set_process(false)
		return
	_host = parsed.host
	_port = parsed.port
	_give_up_at_ms = Time.get_ticks_msec() + CONNECT_GIVE_UP_MS
	set_process(true)
	print("[dsh-bridge] connecting to %s:%d" % [_host, _port])


func _exit_tree() -> void:
	if _tcp != null:
		_tcp.disconnect_from_host()
		_tcp = null


## Returns {"host": String, "port": int} if a valid --dsh-bridge arg is present,
## otherwise an empty Dictionary.
static func _parse_bridge_arg(args: PackedStringArray) -> Dictionary:
	for arg in args:
		if not arg.begins_with(BRIDGE_ARG):
			continue
		var spec := arg.substr(BRIDGE_ARG.length()).strip_edges()
		var sep := spec.rfind(":")
		if sep <= 0 or sep == spec.length() - 1:
			continue
		var host := spec.substr(0, sep).strip_edges()
		var port := int(spec.substr(sep + 1))
		if host != "" and port > 0 and port <= 65535:
			return {"host": host, "port": port}
	return {}


## True when this instance was launched with a usable --dsh-bridge arg.
func is_active() -> bool:
	return _phase != Phase.IDLE or _tcp != null or _host != ""


func is_connected_to_host() -> bool:
	return _phase == Phase.CONNECTED


func _process(_delta: float) -> void:
	if _phase == Phase.DEAD:
		return

	if _quit_in >= 0:
		_quit_in -= 1
		if _quit_in < 0:
			_finish_quit()
			return

	if _phase == Phase.IDLE:
		_maybe_connect()
		return

	_tcp.poll()
	var status := _tcp.get_status()

	if _phase == Phase.CONNECTING:
		if status == StreamPeerTCP.STATUS_CONNECTED:
			_phase = Phase.CONNECTED
			_tcp.set_no_delay(true)
			_announce_in = 1
			_give_up_at_ms = Time.get_ticks_msec() + CONNECT_GIVE_UP_MS
		elif status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
			_drop_connection()
		return

	if status != StreamPeerTCP.STATUS_CONNECTED:
		_drop_connection()
		return

	if _announce_in > 0:
		_announce_in -= 1
		if _announce_in == 0:
			_send_ready()

	_tick_frame_requests()
	_read_available()


func _maybe_connect() -> void:
	var now := Time.get_ticks_msec()
	if now < _retry_at_ms:
		return
	if now > _give_up_at_ms:
		push_warning("[dsh-bridge] could not connect to %s:%d, giving up" % [_host, _port])
		_phase = Phase.DEAD
		set_process(false)
		return
	if _tcp == null:
		_tcp = StreamPeerTCP.new()
	var err := _tcp.connect_to_host(_host, _port)
	if err != OK:
		_retry_at_ms = now + CONNECT_RETRY_MS
		return
	_phase = Phase.CONNECTING


func _drop_connection() -> void:
	if _tcp != null:
		_tcp.disconnect_from_host()
	_phase = Phase.IDLE
	_in_buffer_reset()
	_frame_requests.clear()
	_announce_in = -1
	_retry_at_ms = Time.get_ticks_msec() + CONNECT_RETRY_MS
	_give_up_at_ms = Time.get_ticks_msec() + CONNECT_GIVE_UP_MS


func _in_buffer_reset() -> void:
	_buffer = PackedByteArray()


func _read_available() -> void:
	var available := _tcp.get_available_bytes()
	if available <= 0:
		return
	var chunk := _tcp.get_partial_data(available)
	if int(chunk[0]) != OK:
		_drop_connection()
		return
	_buffer.append_array(chunk[1])
	if _buffer.size() > MAX_BUFFER_BYTES:
		push_warning("[dsh-bridge] input buffer overflow, dropping peer")
		_drop_connection()
		return
	while true:
		var newline := _buffer.find(10)  # '\n'
		if newline < 0:
			return
		var line := _buffer.slice(0, newline).get_string_from_utf8().strip_edges()
		_buffer = _buffer.slice(newline + 1)
		if line.is_empty():
			continue
		_handle_line(line)


func _handle_line(line: String) -> void:
	var parsed: Variant = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("[dsh-bridge] ignoring malformed request: " + line.left(200))
		return
	var request: Dictionary = parsed
	if not request.has("id"):
		push_warning("[dsh-bridge] ignoring request without id: " + line.left(200))
		return
	var id := int(request.get("id", 0))
	var cmd := str(request.get("cmd", ""))
	var args: Dictionary = {}
	var raw_args: Variant = request.get("args", null)
	if raw_args is Dictionary:
		args = raw_args
	elif raw_args != null:
		_reply_error(id, "args must be an object, got %s" % type_string(typeof(raw_args)))
		return

	match cmd:
		"ping":
			_reply_ok(id, {"pong": true, "scene": _current_scene_path(), "paused": get_tree().paused})
		"pause":
			_cmd_pause(id, args)
		"reload":
			_cmd_reload(id, args)
		"tree":
			_cmd_tree(id, args)
		"node":
			_cmd_node(id, args)
		"node_set":
			_cmd_node_set(id, args)
		"node_call":
			_cmd_node_call(id, args)
		"action":
			_cmd_action(id, args)
		"frames":
			_cmd_frames(id, args)
		"screenshot":
			_cmd_screenshot(id, args)
		"quit":
			_cmd_quit(id, args)
		_:
			_reply_error(id, "unknown command: " + cmd)


# --- outbound -----------------------------------------------------------------


func _send_line(payload: Dictionary) -> void:
	if _phase != Phase.CONNECTED or _tcp == null:
		return
	var text := JSON.stringify(payload)
	if text.is_empty():
		return
	var err := _tcp.put_data((text + "\n").to_utf8_buffer())
	if err != OK:
		_drop_connection()


func _reply_ok(id: int, result: Variant) -> void:
	_send_line({"id": id, "ok": true, "result": _json_safe(result)})


func _reply_error(id: int, message: String) -> void:
	_send_line({"id": id, "ok": false, "error": message})


func _send_ready() -> void:
	var version := Engine.get_version_info()
	var engine := "%d.%d.%d" % [
		int(version.get("major", 0)),
		int(version.get("minor", 0)),
		int(version.get("patch", 0)),
	]
	_send_line({
		"event": "ready",
		"engine": engine,
		"project": str(ProjectSettings.get_setting("application/config/name", "Game")),
		"scene": _current_scene_path(),
		"pid": OS.get_process_id(),
	})


func _finish_quit() -> void:
	if _tcp != null:
		_tcp.poll()
		_tcp.disconnect_from_host()
		_tcp = null
	_phase = Phase.DEAD
	get_tree().quit(_quit_code)


# --- helpers ------------------------------------------------------------------


func _current_scene_path() -> String:
	var scene := get_tree().current_scene
	if scene == null:
		return ""
	return str(scene.scene_file_path)


func _resolve_node(path: String) -> Node:
	var wanted := path.strip_edges()
	if wanted.is_empty() or wanted == "." or wanted == "/root":
		return get_tree().root
	# Absolute paths ("/root/Main") and paths relative to /root ("Main") both work.
	return get_tree().root.get_node_or_null(NodePath(wanted))


func _scene_path_of(node: Node) -> String:
	return str(node.scene_file_path)


func _script_path_of(node: Node) -> String:
	var script: Variant = node.get_script()
	if script is Script:
		return str((script as Script).resource_path)
	return ""


## JSON has no type for Vector2/Color/Node references; CONTRACT §4 wants those
## rendered as "<ClassName>" so a model can see what it is looking at.
func _json_safe(value: Variant) -> Variant:
	if value == null:
		return null
	match typeof(value):
		TYPE_BOOL:
			return value
		TYPE_INT:
			return value
		TYPE_FLOAT:
			var f: float = value
			return f if is_finite(f) else str(f)
		TYPE_STRING:
			return value
		TYPE_STRING_NAME:
			return str(value)
		TYPE_NODE_PATH:
			return str(value)
		TYPE_ARRAY:
			var items := []
			for item in value:
				items.append(_json_safe(item))
			return items
		TYPE_DICTIONARY:
			var out := {}
			for key in (value as Dictionary).keys():
				out[str(key)] = _json_safe((value as Dictionary)[key])
			return out
		TYPE_OBJECT:
			var object: Object = value
			if object == null:
				return null
			return "<" + object.get_class() + ">"
		_:
			return "<" + type_string(typeof(value)) + ">"


# --- commands -----------------------------------------------------------------


func _cmd_tree(id: int, args: Dictionary) -> void:
	var depth := int(args.get("depth", 4))
	var include_internal := bool(args.get("includeInternal", false))
	if depth < 0:
		depth = 0
	elif depth > 64:
		depth = 64
	_reply_ok(id, {"root": _describe_tree(get_tree().root, depth, include_internal)})


## `depth` = number of descendant levels included below this node.
func _describe_tree(node: Node, depth: int, include_internal: bool) -> Dictionary:
	var info := {
		"name": str(node.name),
		"path": str(node.get_path()),
		"type": node.get_class(),
		"scene": _scene_path_of(node),
		"children": [],
	}
	if depth <= 0:
		return info
	var children := []
	for child in node.get_children():
		if not include_internal and _is_internal_node(child):
			continue
		children.append(_describe_tree(child, depth - 1, include_internal))
	info["children"] = children
	return info


## Internal nodes are engine bookkeeping; `is_internal()` only exists on some
## Node generations, so probe defensively and default to "not internal".
func _is_internal_node(node: Node) -> bool:
	if node.has_method("is_internal"):
		return bool(node.call("is_internal"))
	return false


func _cmd_node(id: int, args: Dictionary) -> void:
	var path := str(args.get("path", ""))
	var node := _resolve_node(path)
	if node == null:
		_reply_error(id, "node not found: " + path)
		return
	var properties := {}
	var wanted: Variant = args.get("properties", null)
	if wanted is Array:
		for name_variant in wanted:
			var property_name := str(name_variant)
			properties[property_name] = _json_safe(node.get(property_name))
	else:
		properties = _collect_properties(node)
	_reply_ok(id, {
		"name": str(node.name),
		"path": str(node.get_path()),
		"type": node.get_class(),
		"scene": _scene_path_of(node),
		"script": _script_path_of(node),
		"properties": properties,
	})


func _collect_properties(node: Node) -> Dictionary:
	var out := {}
	for property in node.get_property_list():
		if out.size() >= MAX_AUTO_PROPERTIES:
			break
		var usage := int(property.get("usage", 0))
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_INTERNAL):
			continue
		# Editor-visible built-in props plus script member variables (a model
		# debugging a game cares about both).
		if not (usage & (PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_SCRIPT_VARIABLE)):
			continue
		var property_name := str(property.get("name", ""))
		if property_name.is_empty():
			continue
		out[property_name] = _json_safe(node.get(property_name))
	return out


func _property_exists(node: Node, property_name: String) -> bool:
	for property in node.get_property_list():
		if str(property.get("name", "")) == property_name:
			return true
	return false


func _cmd_node_set(id: int, args: Dictionary) -> void:
	var path := str(args.get("path", ""))
	var property_name := str(args.get("property", ""))
	if property_name.is_empty():
		_reply_error(id, "node_set requires \"property\"")
		return
	var node := _resolve_node(path)
	if node == null:
		_reply_error(id, "node not found: " + path)
		return
	if not _property_exists(node, property_name):
		_reply_error(id, "property not found: %s on %s" % [property_name, node.get_class()])
		return
	var current: Variant = node.get(property_name)
	var incoming: Variant = args.get("value", null)
	var coerced := _coerce_for_property(current, incoming)
	if coerced[0]:
		incoming = coerced[1]
	node.set(property_name, incoming)
	_reply_ok(id, {"value": _json_safe(node.get(property_name))})


## JSON has no Vector2/Color; accept `[x, y]` for built-in math properties so
## `node_set` can move things. Anything that does not look like a match is
## passed through unchanged (Godot then reports its own actionable error).
func _coerce_for_property(current: Variant, incoming: Variant) -> Array:
	if not (incoming is Array):
		return [false, incoming]
	var values: Array = incoming
	var numbers_ok := true
	for value in values:
		if not (value is int or value is float):
			numbers_ok = false
			break
	if not numbers_ok:
		return [false, incoming]
	match typeof(current):
		TYPE_VECTOR2:
			if values.size() == 2:
				return [true, Vector2(float(values[0]), float(values[1]))]
		TYPE_VECTOR2I:
			if values.size() == 2:
				return [true, Vector2i(int(values[0]), int(values[1]))]
		TYPE_VECTOR3:
			if values.size() == 3:
				return [true, Vector3(float(values[0]), float(values[1]), float(values[2]))]
		TYPE_VECTOR3I:
			if values.size() == 3:
				return [true, Vector3i(int(values[0]), int(values[1]), int(values[2]))]
		TYPE_COLOR:
			if values.size() == 3:
				return [true, Color(float(values[0]), float(values[1]), float(values[2]))]
			if values.size() == 4:
				return [true, Color(float(values[0]), float(values[1]), float(values[2]), float(values[3]))]
	return [false, incoming]


func _cmd_node_call(id: int, args: Dictionary) -> void:
	var path := str(args.get("path", ""))
	var method := str(args.get("method", ""))
	if method.is_empty():
		_reply_error(id, "node_call requires \"method\"")
		return
	var node := _resolve_node(path)
	if node == null:
		_reply_error(id, "node not found: " + path)
		return
	if not node.has_method(method):
		_reply_error(id, "method not found: %s on %s" % [method, node.get_class()])
		return
	var call_args: Array = []
	var raw_args: Variant = args.get("args", null)
	if raw_args is Array:
		call_args = raw_args
	elif raw_args != null:
		_reply_error(id, "args must be an array, got %s" % type_string(typeof(raw_args)))
		return
	var returned: Variant = node.callv(method, call_args)
	_reply_ok(id, {"return": _json_safe(returned)})


func _cmd_action(id: int, args: Dictionary) -> void:
	var action := str(args.get("action", ""))
	if action.is_empty():
		_reply_error(id, "action requires \"action\"")
		return
	if not InputMap.has_action(action):
		_reply_error(id, "unknown input action: %s (known actions: %s)" % [action, _known_actions()])
		return
	var pressed := true
	if args.has("pressed"):
		pressed = bool(args.get("pressed"))
	if pressed:
		Input.action_press(action)
	else:
		Input.action_release(action)
	_reply_ok(id, {"pressed": pressed})


func _known_actions() -> String:
	var names := PackedStringArray()
	for action in InputMap.get_actions():
		names.append(str(action))
		if names.size() >= 12:
			break
	return ", ".join(names)


func _cmd_frames(id: int, args: Dictionary) -> void:
	var count := int(args.get("count", 1))
	if count < 0:
		_reply_error(id, "frames count must be >= 0")
		return
	if count == 0:
		_reply_ok(id, {"frames": 0})
		return
	_frame_requests.append({"id": id, "remaining": count, "count": count})


func _tick_frame_requests() -> void:
	if _frame_requests.is_empty():
		return
	var pending: Array[Dictionary] = []
	for request in _frame_requests:
		request["remaining"] = int(request["remaining"]) - 1
		if int(request["remaining"]) <= 0:
			_reply_ok(int(request["id"]), {"frames": int(request["count"])})
		else:
			pending.append(request)
	_frame_requests = pending


func _cmd_screenshot(id: int, args: Dictionary) -> void:
	var display := DisplayServer.get_name()
	if display == "headless" or display == "dummy":
		_reply_error(id, "screenshot unavailable: running under the '%s' display driver (headless); use a windowed run" % display)
		return
	var requested := str(args.get("path", "")).strip_edges()
	if requested.is_empty():
		# Default into the project directory: res:// is a normal writable folder
		# for a project run from disk, unlike user:// under sandboxed hosts.
		requested = "res://dsh_screenshot.png"
	var absolute := _absolute_path(requested)
	var directory := absolute.get_base_dir()
	if not directory.is_empty():
		DirAccess.make_dir_recursive_absolute(directory)
	var image: Image = null
	var texture := get_tree().root.get_texture()
	if texture != null:
		image = texture.get_image()
	if image == null or image.is_empty():
		_reply_error(id, "screenshot failed: root viewport has no rendered frame yet")
		return
	var err := image.save_png(absolute)
	if err != OK:
		_reply_error(id, "screenshot failed: could not save '%s' (%s)" % [absolute, error_string(err)])
		return
	var bytes := 0
	var file := FileAccess.open(absolute, FileAccess.READ)
	if file != null:
		bytes = file.get_length()
		file.close()
	_reply_ok(id, {"path": absolute, "bytes": bytes})


func _absolute_path(path: String) -> String:
	if path.begins_with("res://") or path.begins_with("user://"):
		return ProjectSettings.globalize_path(path)
	if path.is_absolute_path():
		return path
	return ProjectSettings.globalize_path("res://" + path)


## Pause or resume the whole scene tree. This node runs with PROCESS_MODE_ALWAYS,
## so it keeps serving commands (and `frames`) while the game is paused.
func _cmd_pause(id: int, args: Dictionary) -> void:
	var tree := get_tree()
	if tree == null:
		_reply_error(id, "pause failed: no running scene tree")
		return
	tree.paused = bool(args.get("paused", true))
	_reply_ok(id, {"paused": tree.paused})


## Reload the currently active scene (the toolbar's refresh button).
## The bridge autoload survives a scene reload, so the connection stays usable.
func _cmd_reload(id: int, args: Dictionary) -> void:
	var tree := get_tree()
	if tree == null:
		_reply_error(id, "reload failed: no running scene tree")
		return
	# A paused tree keeps new gameplay frozen, so a reload always resumes first.
	tree.paused = false
	var scene := _current_scene_path()
	var err := tree.reload_current_scene()
	if err != OK:
		_reply_error(id, "reload failed: %s" % error_string(err))
		return
	_reply_ok(id, {"reloaded": true, "scene": scene})


func _cmd_quit(id: int, args: Dictionary) -> void:
	_quit_code = int(args.get("code", 0))
	_reply_ok(id, {})
	# Give the reply a couple of frames to leave the socket before we exit.
	_quit_in = 2
