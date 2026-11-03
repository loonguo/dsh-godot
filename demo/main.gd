extends Node2D
## BridgeDemo — the game controller.
##
## This is the file an agent should edit first when changing game rules:
## score/lives, the starting layout (INITIAL_COINS / INITIAL_ENEMIES), spawn
## pacing (COIN_SPAWN_SECONDS / ENEMY_SPAWN_SECONDS) and the HUD text all live
## here. Per-actor behaviour lives in player.gd, coin.gd, enemy.gd.
##
## Headless:
##   godot --headless --path demo --quit-after 60        # boot check
##   godot --headless --path demo -- --test              # PASS/FAIL suite
##
## Bridge (see README.md §3):
##   ping / tree / node / node_set / node_call / action / frames / quit
## `debug_state()` returns JSON-safe values; `spawn_coin()` / `spawn_enemy()`
## accept plain numbers, so they are callable through `node_call`:
##   {"id":9,"cmd":"node_call","args":{"path":"/root/Main","method":"spawn_coin",
##                                       "args":[400.0,300.0]}}

signal score_changed(score: int)
signal lives_changed(lives: int)

const PLAYER_SCENE := preload("res://player.tscn")
const COIN_SCENE := preload("res://coin.tscn")
const ENEMY_SCENE := preload("res://enemy.tscn")

const START_POSITION := Vector2(400.0, 520.0)
const PLAYER_ARENA := Rect2(24.0, 24.0, 752.0, 552.0)

## Deterministic starting layout (no RNG at boot, so tests can assert counts).
const INITIAL_COINS: Array[Vector2] = [
	Vector2(180.0, 140.0),
	Vector2(400.0, 140.0),
	Vector2(620.0, 140.0),
	Vector2(620.0, 420.0),
	Vector2(180.0, 420.0),
]
const INITIAL_ENEMIES: Array[Dictionary] = [
	{"position": Vector2(260.0, 260.0), "velocity": Vector2(110.0, 80.0)},
	{"position": Vector2(540.0, 260.0), "velocity": Vector2(-90.0, 120.0)},
	{"position": Vector2(400.0, 380.0), "velocity": Vector2(70.0, -100.0)},
]

const MAX_COINS := 6
const MAX_ENEMIES := 5
const COIN_SPAWN_SECONDS := 1.2
const ENEMY_SPAWN_SECONDS := 2.5

var score := 0
var lives := 3
var game_over := false
## True when launched with `-- --test` or `-- --deterministic`: spawn timers are
## disabled so object counts stay deterministic (the test suite needs this).
var deterministic := false

var _rng := RandomNumberGenerator.new()
var _coin_timer: Timer
var _enemy_timer: Timer

@onready var player = $Player
@onready var coins: Node2D = $Coins
@onready var enemies: Node2D = $Enemies
@onready var status_label: Label = $HUD/Status
@onready var game_over_label: Label = $HUD/GameOver


func _ready() -> void:
	deterministic = "--test" in OS.get_cmdline_user_args() or "--deterministic" in OS.get_cmdline_user_args()
	_rng.seed = 20260101
	player.global_position = START_POSITION
	player.arena = PLAYER_ARENA
	_spawn_initial_objects()
	_update_hud()
	game_over_label.visible = false
	if not deterministic:
		_start_spawn_timers()
	print("DEMO_READY coins=%d enemies=%d deterministic=%s" % [
		coins.get_child_count(), enemies.get_child_count(), str(deterministic),
	])


func _unhandled_input(event: InputEvent) -> void:
	if game_over and event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_R:
		get_tree().reload_current_scene()


# --- spawning ---------------------------------------------------------------

func _spawn_initial_objects() -> void:
	for position in INITIAL_COINS:
		spawn_coin(position.x, position.y)
	for spec in INITIAL_ENEMIES:
		var start: Vector2 = spec["position"]
		var velocity: Vector2 = spec["velocity"]
		spawn_enemy(start.x, start.y, velocity.x, velocity.y)


## Public + bridge-callable: node_call {path:"/root/Main", method:"spawn_coin",
## args:[x, y]}.
func spawn_coin(x: float, y: float) -> Node2D:
	var coin = COIN_SCENE.instantiate()
	# force_readable_name: duplicates become Coin2, Coin3... instead of @Area2D@2
	coins.add_child(coin, true)
	coin.global_position = Vector2(x, y)
	coin.collected.connect(_on_coin_collected)
	return coin


## Public + bridge-callable: node_call {path:"/root/Main", method:"spawn_enemy",
## args:[x, y, velocity_x, velocity_y]}.
func spawn_enemy(x: float, y: float, velocity_x: float = 90.0, velocity_y: float = 60.0) -> Node2D:
	var enemy = ENEMY_SCENE.instantiate()
	enemies.add_child(enemy, true)
	enemy.global_position = Vector2(x, y)
	enemy.velocity = Vector2(velocity_x, velocity_y)
	enemy.touched.connect(_on_enemy_touched)
	return enemy


func _start_spawn_timers() -> void:
	_coin_timer = Timer.new()
	_coin_timer.name = "CoinTimer"
	_coin_timer.wait_time = COIN_SPAWN_SECONDS
	_coin_timer.autostart = true
	_coin_timer.timeout.connect(_on_coin_timer_timeout)
	add_child(_coin_timer)

	_enemy_timer = Timer.new()
	_enemy_timer.name = "EnemyTimer"
	_enemy_timer.wait_time = ENEMY_SPAWN_SECONDS
	_enemy_timer.autostart = true
	_enemy_timer.timeout.connect(_on_enemy_timer_timeout)
	add_child(_enemy_timer)


func _on_coin_timer_timeout() -> void:
	if game_over or coins.get_child_count() >= MAX_COINS:
		return
	var x := 60.0 + _rng.randf() * 680.0
	var y := 60.0 + _rng.randf() * 480.0
	spawn_coin(x, y)


func _on_enemy_timer_timeout() -> void:
	if game_over or enemies.get_child_count() >= MAX_ENEMIES:
		return
	var x := 60.0 + _rng.randf() * 680.0
	var y := 60.0 + _rng.randf() * 480.0
	var angle := _rng.randf() * TAU
	var speed := 80.0 + _rng.randf() * 60.0
	spawn_enemy(x, y, cos(angle) * speed, sin(angle) * speed)


# --- scoring / damage -------------------------------------------------------

func _on_coin_collected(_coin: Node2D) -> void:
	score += 1
	score_changed.emit(score)
	_update_hud()
	print("[demo] coin collected score=%d" % score)


func _on_enemy_touched(body: Node2D) -> void:
	if game_over or body != player:
		return
	if player.take_hit():
		apply_damage()


## Public + bridge-callable: loses one life, respawns the player, or ends the game.
func apply_damage() -> void:
	if game_over:
		return
	lives -= 1
	lives_changed.emit(lives)
	if lives <= 0:
		lives = 0
		_end_game()
	else:
		player.respawn_at(START_POSITION)
	_update_hud()


func _end_game() -> void:
	game_over = true
	if _coin_timer != null:
		_coin_timer.stop()
	if _enemy_timer != null:
		_enemy_timer.stop()
	player.set_physics_process(false)
	game_over_label.visible = true
	print("[demo] game over score=%d" % score)


func _update_hud() -> void:
	status_label.text = "Score: %d  Lives: %d" % [score, lives]


# --- bridge / test helpers --------------------------------------------------

## JSON-safe snapshot for `node_call { path: "/root/Main", method: "debug_state" }`.
func debug_state() -> Dictionary:
	return {
		"score": score,
		"lives": lives,
		"coins": coins.get_child_count(),
		"enemies": enemies.get_child_count(),
		"game_over": game_over,
		"deterministic": deterministic,
		"player_position": [player.global_position.x, player.global_position.y],
		"player_speed": player.speed,
		"hud": status_label.text,
	}
