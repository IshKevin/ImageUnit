# Always uses Docker Compose v2 ("docker compose"). The legacy Python "docker-compose" v1
# crashes on current Docker (KeyError: 'ContainerConfig' / 'id'), so avoid it for this project.
COMPOSE := docker compose

.PHONY: up down logs ps reset
up:     ; $(COMPOSE) up -d --wait
down:   ; $(COMPOSE) down
logs:   ; $(COMPOSE) logs -f
ps:     ; $(COMPOSE) ps
reset:  ; $(COMPOSE) down -v   # DESTROYS local data (database, media, queue)
