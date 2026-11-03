extends Node
## Deterministic headless test suite for BridgeDemo.
##
## Only runs when the game is launched with `--test` after a bare `--`:
##     godot --headless --path demo -- --test
## Exit code is 0 when every assertion passes, 1 otherwise. Each assertion
## prints exactly one `PASS <name>` or `FAIL <name> ...` line, and the last line
## is `TEST SUMMARY passed=<n> failed=<m>`.

var _passed := 0
var _failed := 0
var _main: Node = null


func _ready() -> void:
	if not ("--test" in OS.get_cmdline_user_args()):
		# Normal play/debug runs: stay inert, no output.
		set_process(false)
		return
	_run.call_deferred()


func _run() -> void:
	await _physics_frames(2)
	_main = get_tree().current_scene
	var player = _main.get_node_or_null("Player")
	var bridge = get_node_or_null("/root/Bridge")

	_check("main scene loaded", _main != null and _main.scene_file_path == "res://main.tscn")
	_check("player instantiated in the player group", player != null and player.get_class() == "CharacterBody2D" and player.is_in_group("player"))
	_check("player script attached", player != null and player.get_script() != null and player.get_script().resource_path == "res://player.gd")
	_check("initial score is 0", _main.score == 0)
	_check("initial lives are 3", _main.lives == 3)
	_check("HUD starts at Score: 0  Lives: 3", _main.get_node("HUD/Status").text == "Score: 0  Lives: 3")
	_check("deterministic coin layout (5 coins)", _main.get_node("Coins").get_child_count() == 5)
	_check("deterministic enemy layout (3 enemies)", _main.get_node("Enemies").get_child_count() == 3)
	_check("test mode disables spawn timers", _main.deterministic == true and _main.get_node_or_null("CoinTimer") == null)

	# Movement must go through the real InputMap (what the bridge `action` cmd uses).
	var start_x: float = player.global_position.x
	Input.action_press("ui_right")
	await _physics_frames(20)
	Input.action_release("ui_right")
	_check("action-driven movement moves the player right", player.global_position.x > start_x + 10.0,
		"start_x=%.1f end_x=%.1f" % [start_x, player.global_position.x])

	# Coin pickup: teleport onto the first deterministic coin.
	var score_before: int = _main.score
	var coins: Node = _main.get_node("Coins")
	var coin = coins.get_child(0)
	player.global_position = coin.global_position
	await _physics_frames(8)
	_check("touching a coin raises the score", _main.score == score_before + 1, "score=%d" % _main.score)
	_check("collected coin is freed", not is_instance_valid(coin))
	_check("HUD shows the new score", _main.get_node("HUD/Status").text.begins_with("Score: 1"))

	# Enemy contact: costs a life and respawns the player at START_POSITION.
	var enemies: Node = _main.get_node("Enemies")
	var enemy = enemies.get_child(0)
	var lives_before: int = _main.lives
	player.global_position = enemy.global_position
	await _physics_frames(8)
	_check("touching an enemy costs a life", _main.lives == lives_before - 1, "lives=%d" % _main.lives)
	var start_position := Vector2(400.0, 520.0)  # main.gd START_POSITION
	_check("player respawns at the start position", player.global_position.distance_to(start_position) < 2.0,
		"position=%s" % str(player.global_position))

	# Spawn helpers are the same code path the bridge reaches through node_call.
	var coins_before: int = _main.get_node("Coins").get_child_count()
	_main.callv("spawn_coin", [700.0, 60.0])
	_check("spawn_coin() adds a coin", _main.get_node("Coins").get_child_count() == coins_before + 1)
	var enemies_before: int = _main.get_node("Enemies").get_child_count()
	_main.callv("spawn_enemy", [60.0, 60.0, 10.0, 10.0])
	_check("spawn_enemy() adds an enemy", _main.get_node("Enemies").get_child_count() == enemies_before + 1)

	# JSON-safe debug surface used by bridge node_call.
	var state: Dictionary = _main.callv("debug_state", [])
	_check("debug_state() is JSON-safe and complete",
		state.has("score") and state.has("lives") and state.has("coins") and state.has("player_position")
		and state["player_position"] is Array and state["coins"] is int and state["lives"] is int)

	# The bridge autoload must be inert without --dsh-bridge=host:port.
	_check("bridge is inert without --dsh-bridge", bridge != null and bridge.is_active() == false)
	_check("bridge stringifies non-JSON values", bridge._json_safe(Vector2(3.0, 4.0)) == "<Vector2>")

	# Losing the last life flips the game-over state and shows the label.
	_main.lives = 1
	_main.callv("apply_damage", [])
	_check("last life ends the game", _main.game_over == true and _main.get_node("HUD/GameOver").visible == true)

	print("TEST SUMMARY passed=%d failed=%d" % [_passed, _failed])
	get_tree().quit(0 if _failed == 0 else 1)


func _physics_frames(count: int) -> void:
	for _i in count:
		await get_tree().physics_frame


func _check(name: String, ok: bool, detail: String = "") -> void:
	if ok:
		_passed += 1
		print("PASS ", name)
	else:
		_failed += 1
		if detail.is_empty():
			print("FAIL ", name)
		else:
			print("FAIL ", name, " (", detail, ")")
