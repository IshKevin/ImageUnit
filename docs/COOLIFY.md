# Deploying on Coolify

`compose.yaml` deploys as-is on Coolify: choose **Docker Compose** as the build pack, point it at this repository, and keep the default compose file location (`/compose.yaml`). Coolify's own proxy provides HTTPS, so the bundled Caddy (`--profile https`) is not used.

## 1. Environment variables (Coolify → your resource → Environment Variables)

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | The images build correctly whatever this is set to, but the running app must be `production`. |
| `SESSION_SECRET` | 64 random hex chars (`openssl rand -hex 32`) | **Required.** The app refuses to start in production with a placeholder. |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | long random strings | |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | random strings | credentials of the bundled storage |
| `PUBLIC_WEB_URL` | `https://photos.example.com` | your web domain |
| `API_PUBLIC_URL` | `https://api.example.com` | domain company websites call (`/api/v1/*`) |
| `S3_PUBLIC_ENDPOINT` | `https://media.example.com` | domain browsers use for uploads/downloads |
| `COOKIE_SECURE`, `TRUST_PROXY` | *(leave unset)* | default to `true` automatically when `PUBLIC_WEB_URL` starts with `https://`. Booleans accept `true/false/1/0/yes/no`. |
| `METRICS_TOKEN` | random string | protects `/metrics` |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | your admin login | first boot only; remove afterwards |

Optional: `STORAGE_TOTAL_BYTES` (capacity shown in the dashboard), `MAX_UPLOAD_BYTES`, `WORKER_CONCURRENCY`, `LOG_LEVEL`.
`ops/gen-env.sh` prints a full set of strong values you can paste in (`make prod-env DOMAIN=example.com`, then copy from `.env.production`).

## 2. Domains (Coolify → each service → Domains)

Three DNS records must point at your Coolify server, then set one domain per service **with the container port**:

| Service | Domain | Port |
|---|---|---|
| `web` | `https://photos.example.com` | `4001` |
| `api` | `https://api.example.com` | `4000` |
| `s3` | `https://media.example.com` | `8333` |

`postgres`, `redis`, `worker` get no domain. No host ports are published, so nothing collides with other apps on the server.

## 3. Deploy and verify
1. Deploy. First build takes a few minutes.
2. Open `https://photos.example.com`, sign in with the bootstrap admin, change the password, then delete the two `BOOTSTRAP_*` variables.
3. Create an event and upload a photo: this exercises browser → `media.example.com` (CORS is limited to `PUBLIC_WEB_URL`), the worker, and the public gallery.

## Notes
* **Build-time variables.** Coolify passes variables as Docker build args. Uncheck "Available at Buildtime" for secrets where possible. Setting `NODE_ENV=development` no longer breaks the web build (the Dockerfile forces production mode for `next build`).
* **Persistence.** Data lives in the named volumes `pgdata`, `redisdata`, `s3data`. Back up with Coolify's scheduled backups for Postgres and a periodic copy of the storage volume, or run `ops/backup.sh` on the server (it needs the storage port published; on Coolify use `docker exec`/volume snapshots instead).
* **Scaling image processing:** raise replicas of `worker` in Coolify or set `WORKER_CONCURRENCY`.

## Health checks

| Where | URL / command | Meaning |
|---|---|---|
| API liveness | `GET /health` (also `/api/health`) | process is up |
| API readiness | `GET /ready` (also `/api/ready`) | database **and** object storage reachable; 503 otherwise |
| Web | `GET /healthz` | web server is up (`/api/health` and `/api/ready` also work through the web domain) |
| Worker | `:4002/health` inside the container | 200 only while Redis and Postgres are reachable |

Every service in `compose.yaml` has a container health check built from the above (plus `pg_isready`, `redis-cli ping`, and an S3 gateway probe), so Coolify shows real status and the proxy only routes to healthy containers. Uptime monitors can watch `https://photos.example.com/api/ready` and `https://api.example.com/ready`.

## Troubleshooting: "404 page not found" on a domain

That exact plain-text message comes from Coolify's proxy (Traefik) and means **no route matches the hostname**: the request never reached ImageUnit. Check in this order:

1. **Domain saved on the right service, with the port.** Resource → *Domains for web*: `https://photos.example.com:4001` (the `:4001` is the container port, not something users type). Same for `api` (`:4000`) and `s3` (`:8333`).
2. **Redeploy after changing domains.** Coolify writes the proxy labels into the compose file at deploy time; changing a domain only takes effect on the next deploy.
3. **Container healthy.** The proxy drops containers that are not healthy. Resource page: `web`, `api`, `s3` must show *healthy*. If not, open their logs (a crash on startup is nearly always a missing/placeholder `SESSION_SECRET` or `COOKIE_SECURE` not `true` for `api`).
4. **Proxy is running and on the same network.** Servers → Proxy must be *Running*. If the web container is on an isolated network, enable *Connect to Predefined Network* in the resource's Advanced settings, then redeploy.
5. **Labels really exist.** On the server:
   `docker ps --filter name=web --format '{{.Names}}'` then
   `docker inspect <name> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -i traefik`
   You should see a router rule containing `Host(`photos.example.com`)`. If none, step 1–2 did not take effect.
6. **DNS points at this server** (`dig +short photos.example.com`). A wrong IP usually shows another app's 404 page.

## Getting your first login (or recovering access)

**First login.** On first boot the API creates one administrator from `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (Coolify → Environment Variables), but only if no administrator exists yet. Set both, redeploy, sign in at your web domain, change the password, then delete the two variables.

**Forgot the password, never set the variables, or locked out.** Open the `api` service's *Terminal* in Coolify (or `docker exec -it <api-container> sh` on the server) and run:

```sh
node dist/db/reset-admin.js you@company.com            # creates the admin or resets it, prints a new random password once
node dist/db/reset-admin.js you@company.com 'MyNewPassw0rd!'   # or choose the password (12+ chars, upper, lower, digit)
```
It creates the account if it does not exist; otherwise it resets the password, makes the account an active administrator, clears any lockout and signs out all its sessions. The action is recorded in the audit log (`user.admin_recovered`). Only someone with shell access to the server can do this.

## Check your variables before deploying

Copy the variables from Coolify's *Environment Variables* page (Developer view) into a local text file and validate them with the exact rules the API applies at startup:

```sh
npm install                      # once
npm run check-env -- coolify.env
```
It lists **every** problem at once (a URL missing `https://`, a password under 12 characters, a non-numeric size, a `METRICS_TOKEN` under 16 characters, ...) or prints `OK — the API would start`. Do not commit that file.

## Troubleshooting: `api` is "unhealthy" / "dependency failed to start"

If `api` fails within a couple of seconds of starting, the app refused its configuration (the log looks like a health failure because Docker restarts the crashed container). Run `npm run check-env` above, or open the `api` container **logs** in Coolify (resource → *Logs* → `api`): the first lines say exactly why, in one readable message, e.g.:

* `ImageUnit cannot start: SESSION_SECRET is still the placeholder value` → set a real `SESSION_SECRET` (`openssl rand -hex 32`).
* `ImageUnit cannot start: Invalid environment configuration: BOOTSTRAP_ADMIN_PASSWORD ...` → the bootstrap password needs 12+ characters (or remove both `BOOTSTRAP_ADMIN_*`).
* `COOKIE_SECURE=false with an https PUBLIC_WEB_URL` → remove `COOKIE_SECURE` (it is derived automatically).
* `SESSION_SECRET: Too small` → the secret must be at least 32 characters.

Startup also retries the database and storage for about a minute, so a slow-starting Postgres does not cause this.
