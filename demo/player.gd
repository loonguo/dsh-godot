extends CharacterBody2D
## The player avatar. Edit `speed` here to make the game easier/harder.
##
## Movement uses the built-in `ui_*` InputMap actions, so the bridge `action`
## command drives it for real:
##   {"id":1,"cmd":"action","args":{"action":"ui_right","pressed":true}}
##   {"id":2,"cmd":"frames","args":{"count":30}}
##   {"id":3,"cmd":"node_call","args":{"path":"/root/Main","method":"debug_state"}}
##
## dsh_probe() is JSON-safe on purpose: a model can read it through the bridge.

@export var speed := 260.0
## Playfield rectangle (x, y, width, height) that the player is clamped to.
@export var arena := Rect2(24.0, 24.0, 752.0, 552.0)

var invulnerable_until_ms := 0
var hit_count := 0


func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * speed
	move_and_slide()
	var half := Vector2(16.0, 16.0)
	global_position = global_position.clamp(arena.position + half, arena.end - half)


func _process(_delta: float) -> void:
	# Blink while invulnerable (real-time ms; harmless in headless runs too).
	visible = Time.get_ticks_msec() >= invulnerable_until_ms or (Time.get_ticks_msec() / 120) % 2 == 0


## Returns true if the hit counted. Called by main.gd when an enemy is touched.
func take_hit() -> bool:
	if Time.get_ticks_msec() < invulnerable_until_ms:
		return false
	invulnerable_until_ms = Time.get_ticks_msec() + 1000
	hit_count += 1
	print("[demo] player hit count=%d" % hit_count)
	return true


func respawn_at(spawn: Vector2) -> void:
	global_position = spawn
	velocity = Vector2.ZERO
	invulnerable_until_ms = Time.get_ticks_msec() + 1000


## Bridge helper: godot_bridge { command: "node_call",
## args: { path: "/root/Main/Player", method: "dsh_probe" } }
func dsh_probe() -> Dictionary:
	return {
		"position": [global_position.x, global_position.y],
		"speed": speed,
		"hits": hit_count,
		"invulnerable": Time.get_ticks_msec() < invulnerable_until_ms,
	}
