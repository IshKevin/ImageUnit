# Operations runbook

## Components
| Component | Role | Scale |
|---|---|---|
| `api` | REST API, sessions, public gallery + website API | stateless, N replicas |
| `worker` | Image processing + scheduled maintenance (expiry, retention, alerts, stuck-job recovery) | N replicas; raise `WORKER_CONCURRENCY` |
| `web` | Next.js console and public gallery pages | stateless |
| Postgres | System of record (users, events, audit log) | managed, PITR enabled |
| Redis | Job queue + rate-limit counters | managed; loss is recoverable (see below) |
| S3-compatible bucket (SeaweedFS by default; AWS S3, R2, Garage, ... also work) | Originals, previews, thumbnails | replication/erasure coding + regular `ops/backup.sh` |

Run migrations before rolling a new release: `npm run db:migrate` (the API also applies pending migrations at boot — disable that in multi-replica deployments by running migrations as a release step).

## Deploying to a single server (self-hosted)

(On Coolify see [COOLIFY.md](COOLIFY.md).) Needs a Linux server with Docker Compose v2, ports 80/443 open, and three DNS records pointing at it:
`photos.<domain>` (web), `api.<domain>` (company websites), `media.<domain>` (browser uploads/downloads).

```bash
make prod-env DOMAIN=company.com ADMIN=you@company.com   # writes .env.production with random secrets (mode 600, git-ignored)
make prod-up                                              # the same compose.yaml plus Caddy (auto HTTPS): web, API, worker, Postgres, Redis, SeaweedFS
make prod-ps
```
1. Sign in at `https://photos.<domain>` with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` from `.env.production`, change the password, then delete those two lines from the file and run `make prod-up` again.
2. **Back up `.env.production`** in a password manager. Losing `SESSION_SECRET` signs everyone out and breaks every website's signed image links; the DB/MinIO passwords are needed to restore.
3. Schedule `ops/backup.sh` (daily) and `ops/restore-test.sh` (weekly), and copy `./backups` off the server.
4. `api.<domain>` only forwards `/api/v1/*` to the internet (admin/auth routes are blocked at the proxy); `/metrics` also requires `METRICS_TOKEN`.
5. Managed Postgres/Redis/S3 instead: override `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT` (and the S3 keys) for the `api` and `worker` services in a `compose.override.yaml`, start only `api worker web`, and put your own TLS proxy in front. The object storage is only ever accessed through the S3 API, so any S3-compatible service works.
6. Object storage note: MinIO was archived upstream in April 2026 and is no longer used. Browser CORS on the storage gateway is limited to `PUBLIC_WEB_URL` (`-s3.allowedOrigins`).

## Roles

| Role | Can | Cannot |
|---|---|---|
| Administrator | everything, including deletion, users, websites, settings, audit | |
| Editor | see every event; **create events and invite photographers to them**; rename events; choose the cover; edit media titles, descriptions, tags; organise galleries; hide/show media; build collections; use the library and its bulk tools | upload event photos, publish, delete, change an event's access settings (unless granted), manage users/websites/settings |
| Photographer | create and publish their own events, upload, edit their own media. **When invited to an event** (a *contributor*): see it, upload photos, videos or whole folders, and edit the titles/descriptions/tags of their own uploads | see or touch other photographers' events or uploads; change an event they were invited to; collections; deletion |

**Typical flow:** an editor creates the event and invites the photographers who will cover it (Event → Team). They upload; the editor curates (names, descriptions, galleries, cover); an administrator or a user with the publish permission publishes. Invitations pick from existing photographer accounts (administrators create accounts); there is no email delivery, so invited people see an in-app notification and the event appears in their list as *Shared with you*. Removing someone ends their access immediately; what they uploaded stays in the event. Storage quotas count what each person uploaded, wherever they uploaded it.

Permissions can be adjusted per user in **Users**; admin-only permissions (delete, users, websites, settings, audit) can never be granted to others.

## Deploy checklist
1. Set every variable in `.env.example`; in production `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind a reverse proxy, a 64-char random `SESSION_SECRET`, and a `METRICS_TOKEN`.
2. **Bucket CORS** must allow `PUT` from the web origin with the `Content-Type` header (browsers upload directly to storage).
3. The bucket must not be public. All access is via short-lived presigned URLs minted after access checks.
4. Set `S3_PUBLIC_ENDPOINT` to the hostname browsers can reach.
5. Create the first administrator with `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`, sign in, change the password, then remove the variables.
6. Expose only `web` (and `api` for external websites at `/api/v1/*`). Block `/metrics` at the proxy or keep it token-protected.

## Backup and recovery
* `ops/backup.sh` — Postgres dump (custom format) + full media mirror + manifest + checksum. Schedule at least daily; ship off-site.
* `ops/restore-media.sh <backup>` — copies the media of a backup back into the bucket (also the way to migrate between storage systems).
* `ops/restore-test.sh <backup>` — restores into a scratch database, verifies admins exist and that **every original referenced in the database exists in the media backup**. Run it on a schedule (weekly) and after every change to backup tooling. Record the result.
* Production databases should additionally use managed point-in-time recovery; if your object storage supports versioning enable it; otherwise the daily `ops/backup.sh` media mirror is what makes an accidental delete recoverable independently of application logic.

| Scenario | Recovery |
|---|---|
| Accidental photo/event deletion | Deletions are admin-only and audited (who/what/when). Restore the objects from bucket versioning or the latest media backup and the rows from the database backup/PITR. Expiry and archiving never delete media, so most "lost gallery" reports are status changes: reactivate from the console. |
| Database loss | Restore latest dump / PITR, run migrations, re-run `restore-test.sh` checks. Photos in `uploaded`/`processing` are re-queued automatically by the stuck-photo sweeper. |
| Redis loss | No data loss: queued jobs are rebuilt by the sweeper within ~15 minutes (photos remain `uploaded`); rate-limit counters reset. |
| Storage loss | Restore from replication/backup. Derived previews/thumbnails can be regenerated from originals via *Retry processing*. |
| Compromised website credential | Console → Websites → **Revoke**. Effect is immediate (checked per request, including outstanding signed media links); other websites are unaffected. |
| Compromised account | Console → Users → **Suspend** (live sessions die immediately) then reset password. |

## Monitoring
* `GET /health` (liveness), `GET /ready` (DB + storage), `GET /metrics` (Prometheus; set `METRICS_TOKEN`).
* Console → **System health**: dependency status, queue depth, failed/stuck photos, abandoned uploads, account lockouts. Failures also raise administrator notifications (processing failures, storage threshold, retention reviews).
* Suggested alerts: `/ready` non-200 for 2 min; `http_request_duration_seconds` p95 > 1s; queue `waiting` growing for 15 min; any `failed` photos; storage ≥ 85%.

## Retention lifecycle
`draft → active → expired → archived → scheduled_for_deletion → (admin) permanent delete`.
* Expiry ends public access only. Media is retained.
* Archived events are flagged `scheduled_for_deletion` after `archiveRetentionMonths` (Settings). **Nothing is auto-deleted**; an administrator reviews and deletes (or reactivates).
* Permanent deletion requires the event to be archived and the link typed as confirmation, and is audited.

## Security notes
* Passwords: argon2id. Sessions: opaque random tokens, hashed at rest, revocable, `HttpOnly; SameSite=Lax`. Lockout after 5 failed logins (15 min).
* Authorization is enforced server-side per route; photographers only ever see their own events (others return 404). Admin-only permissions cannot be granted to photographers.
* Website API keys are stored as SHA-256 hashes, shown once, scoped, rate-limited per key, optionally restricted to specific events/origins. Media links returned to websites are HMAC-signed, expire in 1 h, and re-validate the credential on every request.
* Uploads are validated by declared type, size, and **actual file bytes** (magic-number sniffing + full decode) before processing. GPS EXIF is never stored or republished; previews are re-encoded (metadata stripped).
* The audit log is append-only at the database level (triggers reject UPDATE/DELETE/TRUNCATE).
