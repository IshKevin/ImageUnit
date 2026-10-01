# ImageUnit — Event Media Management & Distribution Platform

Centralised platform for event photographers, attendees, and the company's websites. See [Project.md](Project.md) for the full specification.

**Stack:** Node 24 · TypeScript 7 · Fastify 5 · PostgreSQL 18 (Drizzle) · Redis 8 + BullMQ · S3-compatible storage (SeaweedFS) · sharp · Next.js 16 (React 19, Tailwind 4) · Vitest 5 · Playwright.

```
apps/api   REST API + background worker (server.ts / worker.ts)
apps/web   Photographer/admin console and public galleries
ops/       backup + verified-restore scripts
docs/      runbook, data-protection checklist, website API
```

## Run everything (one command)
```bash
cp .env.example .env
docker compose up -d --build --wait      # or: make up
```
That single compose file runs the web app (http://localhost:4001), API (:4000), background worker, Postgres 18, Redis 8 and SeaweedFS S3 storage (:8333). Sign in with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` from `.env`. Requires Docker Compose **v2** (`docker compose`, with a space).

Everyday commands: `make logs`, `make ps`, `make down`, `make reset` (wipes local data). Scale image processing with `docker compose up -d --scale worker=3`.

### Developing with hot reload
```bash
make dev                  # starts only Postgres, Redis and S3
npm install
npm run dev:api           # http://localhost:4000  (stop the containerised api/web first: docker compose stop api worker web)
npm run dev:worker
npm run dev:web           # http://localhost:4001
```

## Tests
`npm run test:e2e` drives a real Chromium browser through every role's workflow (52 scenarios: administrator, photographer, editor, invited photographers, folder uploads, covers, mobile attendee, private gallery, video upload and playback, library, collections, website client, and the security boundaries between them). It needs the whole stack running (infra, API, worker, `next start`) and the admin credentials from `.env`.

`npm test` runs the API integration suite against a real Postgres (`imageunit_test`, created automatically) with an in-memory storage double. It covers the Definition-of-Done security and reliability scenarios: cross-photographer isolation, admin-only deletion, suspension, website revocation, private galleries, expiry-without-data-loss, failed-upload retry, audit immutability.

## Architecture in one paragraph
Browsers upload originals **directly to object storage** via presigned URLs; the API records them and enqueues a job. Workers validate the bytes, generate preview + thumbnail, and flip the photo to `ready` — originals are never modified, so a failed derivative is just a retry. All media is served through access-checked redirects to short-lived signed URLs, so storage layout is never exposed and expiry/revocation apply within seconds. Event expiry is enforced at read time (not just by a scheduler) and never deletes media. Every sensitive action writes an append-only audit record in the same transaction as the change.

## Status against the MVP (Project.md §38)
Implemented: photos **and videos** (MP4/MOV/WebM/MKV up to 2 GB, converted in the background to a web-playable MP4 + poster), per-item titles/descriptions/tags, an **editor** role, a searchable **library** with bulk editing for large archives, cross-event **collections** for websites, users/roles/permissions/suspension, events + lifecycle, galleries, bulk upload with progress/retry, processing pipeline, public galleries + QR + download control, private galleries, admin-only deletion, storage monitoring, analytics, audit log, notifications, website registration/keys/revocation/usage and the v1 media API, retention flagging, backup + restore verification.

Not yet built (post-MVP per §39, or needing business decisions): payments (schema has `payment_model/status` placeholders; §28 model is undecided), email/SMS delivery of notifications (in-app only), OAuth/2FA, multi-tenancy, watermarking, face search. The data-protection decisions in [docs/DATA-PROTECTION.md](docs/DATA-PROTECTION.md) must be made before launch.
