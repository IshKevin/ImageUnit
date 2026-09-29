# ImageUnit — Event Media Management & Distribution Platform

Centralised platform for event photographers, attendees, and the company's websites. See [Project.md](Project.md) for the full specification.

**Stack:** Node 24 · TypeScript 7 · Fastify 5 · PostgreSQL 18 (Drizzle) · Redis 8 + BullMQ · S3-compatible storage (MinIO) · sharp · Next.js 16 (React 19, Tailwind 4) · Vitest 5 · Playwright.

```
apps/api   REST API + background worker (server.ts / worker.ts)
apps/web   Photographer/admin console and public galleries
ops/       backup + verified-restore scripts
docs/      runbook, data-protection checklist, website API
```

## Local development
```bash
cp .env.example .env
npm install
npm run infra:up          # (Docker Compose v2: `docker compose`, not `docker-compose`) Postgres :5440, Redis :6390, MinIO :9100 (console :9101)
npm run dev:api           # http://localhost:4000  (applies migrations, creates bootstrap admin)
npm run dev:worker        # image processing + maintenance
npm run dev:web           # http://localhost:4001
```
Sign in at http://localhost:4001 with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.

## Tests
`npm run test:e2e` drives a real Chromium browser through every role's workflow (30 scenarios: administrator, photographer, mobile attendee, private gallery, website client, and the security boundaries between them). It needs the whole stack running (infra, API, worker, `next start`) and the admin credentials from `.env`.

`npm test` runs the API integration suite against a real Postgres (`imageunit_test`, created automatically) with an in-memory storage double. It covers the Definition-of-Done security and reliability scenarios: cross-photographer isolation, admin-only deletion, suspension, website revocation, private galleries, expiry-without-data-loss, failed-upload retry, audit immutability.

## Architecture in one paragraph
Browsers upload originals **directly to object storage** via presigned URLs; the API records them and enqueues a job. Workers validate the bytes, generate preview + thumbnail, and flip the photo to `ready` — originals are never modified, so a failed derivative is just a retry. All media is served through access-checked redirects to short-lived signed URLs, so storage layout is never exposed and expiry/revocation apply within seconds. Event expiry is enforced at read time (not just by a scheduler) and never deletes media. Every sensitive action writes an append-only audit record in the same transaction as the change.

## Status against the MVP (Project.md §38)
Implemented: users/roles/permissions/suspension, events + lifecycle, galleries, bulk upload with progress/retry, processing pipeline, public galleries + QR + download control, private galleries, admin-only deletion, storage monitoring, analytics, audit log, notifications, website registration/keys/revocation/usage and the v1 media API, retention flagging, backup + restore verification.

Not yet built (post-MVP per §39, or needing business decisions): payments (schema has `payment_model/status` placeholders; §28 model is undecided), email/SMS delivery of notifications (in-app only), OAuth/2FA, multi-tenancy, watermarking, face search. The data-protection decisions in [docs/DATA-PROTECTION.md](docs/DATA-PROTECTION.md) must be made before launch.
