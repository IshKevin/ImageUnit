# Always uses Docker Compose v2 ("docker compose"). The legacy Python "docker-compose" v1 crashes on current Docker.
COMPOSE := docker compose

.PHONY: up build down logs ps infra dev reset
up:     ; $(COMPOSE) up -d --build --wait      # everything: web, API, worker, Postgres, Redis, S3 storage
down:   ; $(COMPOSE) down
logs:   ; $(COMPOSE) logs -f --tail=100
ps:     ; $(COMPOSE) ps
infra:  ; $(COMPOSE) up -d --wait postgres redis s3   # only dependencies, for running api/worker/web on the host
dev:    infra ; @echo "Now run: npm run dev:api / dev:worker / dev:web"
reset:  ; $(COMPOSE) down -v                    # DESTROYS local data (database, media, queue)

# ---- production (one server, HTTPS via Caddy; see docs/RUNBOOK.md) ----
PROD := ENV_FILE=.env.production $(COMPOSE) --env-file .env.production --profile https
.PHONY: prod-env prod-up prod-down prod-logs prod-ps
prod-env:  ; @test -n "$(DOMAIN)" || (echo "usage: make prod-env DOMAIN=company.com [ADMIN=you@company.com]"; exit 1); ./ops/gen-env.sh $(DOMAIN) $(ADMIN)
prod-up:   ; $(PROD) up -d --build --wait
prod-down: ; $(PROD) down
prod-logs: ; $(PROD) logs -f --tail=100
prod-ps:   ; $(PROD) ps
