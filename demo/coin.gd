extends Area2D
## A collectible. The player is in the "player" group; touching a coin awards a
## point via the `collected` signal that main.gd subscribes to.

signal collected(coin)

var spin_speed := 2.5


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _process(delta: float) -> void:
	rotation += spin_speed * delta


func _on_body_entered(body: Node2D) -> void:
	if body.is_in_group("player"):
		collected.emit(self)
		queue_free()
