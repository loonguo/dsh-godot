extends Area2D
## A hazard. Bounces around the arena and emits `touched` when the player enters.
## main.gd turns that into a lost life.

signal touched(body)

@export var velocity := Vector2(90.0, 60.0)
@export var arena := Rect2(24.0, 24.0, 752.0, 552.0)
@export var radius := 12.0


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _physics_process(delta: float) -> void:
	position += velocity * delta
	if position.x < arena.position.x + radius:
		position.x = arena.position.x + radius
		velocity.x = absf(velocity.x)
	elif position.x > arena.end.x - radius:
		position.x = arena.end.x - radius
		velocity.x = -absf(velocity.x)
	if position.y < arena.position.y + radius:
		position.y = arena.position.y + radius
		velocity.y = absf(velocity.y)
	elif position.y > arena.end.y - radius:
		position.y = arena.end.y - radius
		velocity.y = -absf(velocity.y)


func _on_body_entered(body: Node2D) -> void:
	if body.is_in_group("player"):
		touched.emit(body)
