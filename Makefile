# Always uses Docker Compose v2 ("docker compose"). The legacy Python "docker-compose" v1
# crashes on current Docker (KeyError: 'ContainerConfig' / 'id'), so avoid it for this project.
COMPOSE := docker compose

.PHONY: up down logs ps reset
up:     ; $(COMPOSE) up -d --wait
down:   ; $(COMPOSE) down
logs:   ; $(COMPOSE) logs -f
ps:     ; $(COMPOSE) ps
reset:  ; $(COMPOSE) down -v   # DESTROYS local data (database, media, queue)

# ---- production (single server, self-hosted infra + Caddy HTTPS) ----
PROD := docker compose -f docker-compose.prod.yml --env-file .env.production --profile selfhosted
.PHONY: prod-env prod-up prod-down prod-logs prod-ps
prod-env: ; @test -n "$(DOMAIN)" || (echo "usage: make prod-env DOMAIN=company.com [ADMIN=you@company.com]"; exit 1); ./ops/gen-env.sh $(DOMAIN) $(ADMIN)
prod-up:   ; $(PROD) up -d --build
prod-down: ; $(PROD) down
prod-logs: ; $(PROD) logs -f --tail=100
prod-ps:   ; $(PROD) ps
