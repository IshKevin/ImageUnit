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
| `COOKIE_SECURE` | `true` | required in production |
| `TRUST_PROXY` | `true` | Coolify's proxy sits in front |
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
