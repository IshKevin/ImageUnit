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

Optional: `CORS_ORIGINS` (see below), `STORAGE_TOTAL_BYTES` (capacity shown in the dashboard), `MAX_UPLOAD_BYTES` (photos, default 100 MB), `MAX_VIDEO_BYTES` (videos, default 2 GB), `WORKER_CONCURRENCY` (photo processing, default 4), `WORKER_VIDEO_CONCURRENCY` (simultaneous video conversions per worker, default 1), `LOG_LEVEL`.
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

## Video: what the server needs

Videos are converted by the `worker` service with a bundled ffmpeg (no system install needed). Converting is CPU-heavy and works on a temporary copy of the file:
* **CPU / RAM:** about 1 CPU core and 1 GB RAM per simultaneous conversion. Keep `WORKER_VIDEO_CONCURRENCY=1` on small servers; scale by adding `worker` replicas instead.
* **Disk:** the worker needs free space in its container filesystem (`/tmp`) of roughly 2× the largest video (a 2 GB upload needs about 4 GB while it is processed). The temporary files are deleted afterwards, even when a conversion fails.
* **Storage:** the original is kept untouched; each video also stores a smaller MP4 for playback and a poster image.

## Letting other websites call the API from a browser (CORS)

By default only the ImageUnit web app may call the API and load images from storage in a browser. To change that, set **`CORS_ORIGINS`** in Coolify and redeploy:

| Value | Effect |
|---|---|
| *(empty)* | only your web app (`PUBLIC_WEB_URL`) |
| `*` | **any website** may call the API (`/api/v1`, public galleries) and load photos/videos from storage |
| `https://a.com,https://b.com` | exactly those sites, plus the web app |

It applies to both the API and the image storage (the `s3` service reads the same variable), so a website can use `fetch()` or `<img crossorigin>` on the links the API returns. With `*` the API never allows cookies for other sites, so a stranger's page cannot act as a signed-in user; website keys (bearer tokens) and public galleries work from anywhere. Server-to-server calls never needed CORS. Keep website keys out of browser code regardless: pass the signed `urls` to the browser instead.

## Cross-origin protection (`ORIGIN_CHECK`)

When a signed-in browser sends a request that changes data, the server checks that the request comes from the same website the browser is on, so another site cannot replay someone's login cookie. This needs **no configuration** by default: the request's origin must match the host the browser used to reach the server (read from the proxy's `X-Forwarded-Host`), whatever `PUBLIC_WEB_URL` says. Requests from tools without an `Origin` header (curl, servers) are not affected.

`ORIGIN_CHECK` changes the behaviour:

| Value | Effect |
|---|---|
| *(empty)* or `host` | default: accept the host the browser actually used (plus `PUBLIC_WEB_URL` and `CORS_ORIGINS` sites) |
| `strict` | accept only `PUBLIC_WEB_URL` and `CORS_ORIGINS` sites |
| `off` | **no check at all**. Cookies are still `SameSite=Lax`, which already stops browsers sending them from other sites, but this removes the second layer |

A rejection reads "Cross-origin request rejected: this request came from X but was sent to Y"; X is the page that made the request.

`PUBLIC_WEB_URL` should still be set to your real address (`https://gallery.afs-rwanda.org`): it is used for the share links, QR codes and links in emails and API responses.

## Uploads fail with "File was not received" or "Uploads are not available yet"

Almost always `S3_PUBLIC_ENDPOINT` was never set. It then defaults to `http://localhost:8333`, which means *the visitor's own computer*, so the browser sends the photo there instead of to your server. The server now refuses to hand out such links in production ("Uploads are not available yet…") and tells administrators in the console. To fix it:

1. **DNS:** create a record for a storage domain, e.g. `media.afs-rwanda.org`, pointing at the same server IP as the site.
2. **Coolify → the `s3` service → Domains:** `https://media.afs-rwanda.org:8333` (the `:8333` is the container port).
3. **Environment variables:** `S3_PUBLIC_ENDPOINT=https://media.afs-rwanda.org` (https, no port, no path).
4. **Redeploy**, then open **System health → Photo and video uploads**. Uploads that were left half-done show as failed; use **Retry failed** or upload again.

## "Network error" when uploading photos

Photos and videos are uploaded **directly from the browser to the storage service** (the `s3` service), so that service needs its own public domain, and the browser must be able to talk to it. Open **Console → System health → Photo and video uploads**: it tests this the way a browser would and says what is wrong. The usual causes:

1. **The `s3` service has no domain.** In Coolify give it one with the container port, e.g. `https://media.afs-rwanda.org:8333` (DNS pointing at the server), and redeploy.
2. **`S3_PUBLIC_ENDPOINT` does not match that domain.** It must be exactly `https://media.afs-rwanda.org` (https, no port, no path). If it says `localhost`, `s3` or `http://…` on an https site, uploads fail ("mixed content" is blocked by browsers).
3. **CORS.** The storage service accepts browsers from any site by default (the upload links are signed and short-lived). If you restricted it with `S3_CORS_ORIGINS` or `CORS_ORIGINS`, include your site's address, then redeploy the `s3` service.

After any change, redeploy and retry; failed files in the upload list have a **Retry failed** button, so nothing is re-picked.
