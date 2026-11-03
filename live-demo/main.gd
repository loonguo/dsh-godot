extends Node2D
## Star Catcher — built by the agent through the dsh-godot tools.
## Bridge debug surface: debug_state() and reset_state().

const SPEED := 320.0
const FALL_SPEED := 180.0
const CATCH_RADIUS := 28.0
const FLOOR_Y := 520.0

var score := 0
var misses := 0
var player_x := 400.0
var star_pos := Vector2(400.0, 40.0)


func _ready() -> void:
	print("GAME_READY score=", score)
	$Hud.text = _hud_text()


func _process(delta: float) -> void:
	if Input.is_action_pressed("ui_left"):
		player_x -= SPEED * delta
	if Input.is_action_pressed("ui_right"):
		player_x += SPEED * delta
	player_x = clampf(player_x, 40.0, 760.0)
	$Player.position = Vector2(player_x, FLOOR_Y)

	star_pos.y += FALL_SPEED * delta
	$Star.position = star_pos

	if star_pos.distance_to(Vector2(player_x, FLOOR_Y)) <= CATCH_RADIUS:
		score += 1
		print("CATCH score=", score)
		_reset_star()
	elif star_pos.y > 640.0:
		misses += 1
		print("MISS misses=", misses)
		_reset_star()

	$Hud.text = _hud_text()


func _reset_star() -> void:
	star_pos = Vector2(80.0 + fmod(float(score * 137 + misses * 71), 640.0), 40.0)


func _hud_text() -> String:
	return "score %d  misses %d" % [score, misses]


## Bridge helper: one JSON-safe snapshot of the game state.
func debug_state() -> Dictionary:
	return {
		"score": score,
		"misses": misses,
		"player_x": player_x,
		"star": [star_pos.x, star_pos.y],
	}


## Bridge helper: put the game back into its initial state.
func reset_state() -> void:
	score = 0
	misses = 0
	player_x = 400.0
	star_pos = Vector2(400.0, 40.0)
	$Hud.text = _hud_text()
