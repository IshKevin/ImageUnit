# Incident: photo storage outage (2026-11-10 → 2026-11-11)

| | |
|---|---|
| **Status** | Resolved. One follow-up is still open: event deletion (see [Open items](#open-items)). |
| **Impact** | Photo previews did not load and uploads stayed on "uploading". Sign-in, browsing and AFS SSO kept working. |
| **Duration** | About 21 hours: from the deploy of `202a465` on 2026-11-10 (~17:30 CAT) until the fix deploy on 2026-11-11 (~14:08 CAT). |
| **Data loss** | No stored photos were lost. Photos that people tried to upload *during* the outage never reached storage and must be uploaded again. |
| **Root cause** | One deploy ran SeaweedFS **3.80** on data created by **4.48**. 3.80 runs as root and left root-owned files in the volume. Every 4.x version afterwards failed to start with `permission denied`. |
| **Fix** | `3ba71fe`: pin SeaweedFS to 4.48 and repair file ownership at container start. `0cacf94`: restore the strict health checks. |

## Symptoms

- Gallery and console thumbnails and previews were blank or broken.
- Uploads stayed on "uploading" forever.
- `GET https://imageapi.afs-rwanda.org/ready` returned `503 {"status":"unavailable","db":true,"storage":false}`.
- `https://media.afs-rwanda.org/` returned `503` from the Coolify proxy, because no storage container was answering.
- Before the temporary workarounds below, deploys failed at the `s3` service and took the whole gallery down.

Browsers load and upload files directly at `S3_PUBLIC_ENDPOINT` (`media.afs-rwanda.org`) through signed links. When the
storage container is down, the page renders but every image request and upload `PUT` fails.

## Timeline

All times are CAT (UTC+2).

| When | What happened |
|---|---|
| 2026-09-29 | First production setup. Compose used `chrislusf/seaweedfs:latest`, which resolved to **4.48**, so the `s3data` volume was created by 4.48. |
| 2026-11-02 | On the `afs-sso` branch, `66daf78` pinned `seaweedfs:3.80` (a *downgrade*) and changed `postgres:18-alpine` to `postgres:18`. |
| 2026-11-10 16:20 | `d88494c` merged `afs-sso` into `main` and was deployed. **SeaweedFS 3.80 ran on the 4.48 data.** It started and served files, but it wrote root-owned files into `/data/m9333` (the master's raft state). |
| 2026-11-10 17:32 | `202a465` (merge of `afs-sso-deploy`) set the image back to `latest`, which now resolved to **4.53**. From this deploy on, **s3 failed at every start**. |
| 2026-11-10 17:46 | `d2294f6` lengthened the s3 health-check window, on the theory that a slow volume load was the problem. It did not help. |
| 2026-11-10 18:03 | `78f6c78` pinned 4.53 to stop `latest` from drifting. Storage was still down. |
| 2026-11-10 18:30–18:46 | Temporary workarounds so the rest of ImageUnit could stay up (see below): `fc1d024`, `e3c0844`. |
| 2026-11-11 morning | Investigation: compared the image history, then reproduced the crash locally (method below). |
| 2026-11-11 14:04 | `3ba71fe`: pin 4.48 and repair ownership at start. |
| 2026-11-11 ~14:08 | Deployed. s3 started and loaded the existing volumes 8–18. The worker logged `object storage ready` and `/ready` returned `storage: true`. |
| 2026-11-11 14:13 | `0cacf94`: temporary workarounds reverted, so deploys depend on s3 being healthy again. |

## Root cause

### What happened

1. SeaweedFS **3.x** images run `weed` as **root**.
2. SeaweedFS **4.x** images start as root, then switch to the `seaweed` user (uid 1000) through `/entrypoint.sh` and `su-exec`.
3. The 4.x entrypoint repairs ownership **only if the top-level `/data` folder has the wrong owner**:
   ```sh
   DATA_UID=$(stat -c '%u' /data)
   if [ "$DATA_UID" != "$SEAWEED_UID" ] ...; then chown -R seaweed:seaweed /data; fi
   ```
4. 4.48 had created `/data` as uid 1000. When 3.80 ran, it left `/data` itself alone but created
   `/data/m9333/{conf,log,snapshot}` as `root`, with mode `0600`.
5. On the next 4.x start, `/data` still belonged to uid 1000, so the entrypoint skipped its repair. Then `weed`, now
   running as uid 1000, could not open the root-owned raft log, and the master exited:
   ```
   F master.go:289 please verify /data is writable, see https://github.com/seaweedfs/seaweedfs/issues/717:
     raft: Initialization error: open /data/m9333/log: permission denied
   ```
6. The master is fatal to `weed server`, so the filer and the S3 gateway on port 8333 never started.

### Why rolling back the image alone does not fix it

The bad files stay in the volume. Locally, **4.48 crashes with the same `permission denied`** after 3.80 has run, just
like 4.53. The version number was never the real problem; the root-owned files were.

### Why it took a while to find

- Coolify did not show the s3 crash log during the first attempts, so the first fixes (longer start period, pinning
  4.53) were based on theories.
- Moving from 4.48 to 4.53 looked like the obvious change. A local test had shown that 4.53 opens 4.48 data fine. That
  test passed only because it never included the brief 3.80 deploy in between.
- The 3.80 deploy itself did not fail; it served files normally. The damage only showed on the *next* deploy.

## How it was confirmed

The production history was reproduced on throwaway Docker volumes (never on production data):

| Sequence on one volume | Result |
|---|---|
| 4.48 writes a bucket and a photo → 4.53 | Starts; photo intact |
| 4.48 → **3.80** → 4.53 | **Crashes: `open /data/m9333/log: permission denied`** |
| 4.48 → **3.80** → 4.48 | **Crashes: same error** |
| 4.48 → 3.80 → *ownership repair* → 4.48 | Starts; bucket listing and photo bytes identical |
| 4.48 → 3.80 → *ownership repair* → 4.53 | Starts; bucket listing and photo bytes identical |

After 3.80 ran, `ls -ln /data/m9333` showed `conf`, `log` and `snapshot` owned by `0 0`, while `/data` itself was
`1000 1000`. In that test, 39 files were root-owned in total.

## The fix

`compose.yaml`, service `s3` (commit `3ba71fe`):

```yaml
image: chrislusf/seaweedfs:4.48
entrypoint: ["/bin/sh", "-c", "find /data ! -user seaweed -exec chown seaweed:seaweed {} + ; exec /entrypoint.sh \"$$@\"", "--"]
```

- `find ... ! -user seaweed` only changes files with the wrong owner. On healthy data it changes nothing, and it costs
  one pass over the file list at startup.
- `exec /entrypoint.sh "$@"` then runs the image's normal entrypoint with the usual `command:` arguments, so SeaweedFS
  starts exactly as before.
- 4.48 is the version the data was created with. Moving to a newer 4.x is safe (4.53 was tested), but do it on
  purpose, never through `latest`.

The production s3 log after the fix showed a normal start: master, volume server, filer, S3 gateway, and existing
volumes 8–18 registered. The worker log showed `object storage ready`.

> The `Volume N becomes crowded` lines in the s3 log only mean those volumes are close to the 1 GB
> `-master.volumeSizeLimitMB`. SeaweedFS creates new volumes as needed; this is not an error.

## Temporary workarounds (now reverted)

These kept sign-in and browsing up while storage was down. They were added on 2026-11-10 and **reverted on 2026-11-11
in `0cacf94`**:

| Change while down | Restored to |
|---|---|
| api/worker `depends_on: s3: service_started` | `service_healthy` |
| api health check on `/health` (process up) | `/ready` (database + storage) |

**Kept on purpose:** `apps/api/src/bootstrap.ts` checks storage in the background (`e3c0844`) instead of blocking API
startup. With the strict checks restored, a deploy with broken storage still fails. At runtime, though, a brief storage
outage no longer takes the API down. It reconnects on its own, as the worker did during the fix deploy.

## Effect on data

- **Photos stored before and during the 3.80 window: safe.** They are in the same `s3data` volume, and the repair only
  changes file ownership.
- **Uploads attempted during the outage:** the files never reached storage. Their database rows stay as `pending_upload`
  or `failed`. The same photo can be uploaded again (`apps/api/src/modules/photos.ts`, the `uploads/complete` check).
  Rows that never get a file appear as *abandoned* under Console → System health after 24 hours.
- The `s3data` and `pgdata` volumes were never deleted or recreated.

## Lessons and rules going forward

1. **Never use a SeaweedFS 3.x image on this data.** Never run an image older than the one that wrote the data.
2. **Never use `latest` for stateful services.** Pin exact versions and upgrade on purpose. Treat an image change in a
   feature branch as a production change and review it as one.
3. **Get the container log first.** The real error was a single fatal line. On Coolify: ImageUnit → Logs → `s3` (or the
   failing service).
4. **Reproduce data-related failures on a copy, in order.** Repeat the full sequence of versions that touched the data,
   not just the first and last.
5. **Rolling back the image is not always enough.** If an image change leaves state in a volume, the rollback has to
   repair that state too.
6. **Health checks should gate deploys.** The `/ready` check would have stopped the bad deploy right away, instead of
   the outage being found through broken thumbnails.

## Follow-ups

- [x] Storage restored and strict health checks back (`3ba71fe`, `0cacf94`).
- [ ] **Postgres image flip-flop:** the same window switched `postgres:18-alpine` → `postgres:18` (Debian) →
      `postgres:18-alpine`. Alpine (musl) and Debian (glibc) sort text differently, so indexes on text columns built
      under one may be ordered wrongly under the other. The database is working, but check it once:
      ```sql
      SELECT datname, datcollate, datcollversion FROM pg_database;
      ```
      Also look for a `collation version mismatch` warning in the postgres log. If it is there, or if lookups by slug or
      email behave oddly, run `REINDEX DATABASE imageunit;` in a quiet period. Keep `postgres:18-alpine` pinned from now on.
- [ ] **Backups:** take a scheduled snapshot of the `s3data` volume (see `docs/COOLIFY.md` → Persistence). No backup
      of storage existed during this incident.
- [ ] **Alerting:** alert when `/ready` is non-200 for 2 minutes (`docs/RUNBOOK.md` → Monitoring). This outage was found
      by users.
- [ ] `docs/RUNBOOK.md` still says storage CORS is limited to `PUBLIC_WEB_URL`. Compose now defaults to
      `S3_CORS_ORIGINS` / `CORS_ORIGINS`, falling back to `*`. Update that line.

## Open items

### Event deletion does not work (reported 2026-11-11, cause not found yet)

Already ruled out:

- **Storage deletes:** `DeleteObjects` and `DeleteObject` with `@aws-sdk/client-s3` 3.1142.0 (the locked version, with
  `requestChecksumCalculation: 'WHEN_REQUIRED'`) work against SeaweedFS 4.48, including keys that do not exist.
- **Database:** every table that references `events` uses `ON DELETE CASCADE`. `audit_logs` (append-only, guarded by a
  trigger) has no foreign key to `events`, so it cannot block the delete.
- **Web client and proxy:** `del()` handles the API's `204 No Content`, and CORS allows `DELETE`.

The endpoint `DELETE /api/events/:id?confirm=<slug>` (`apps/api/src/modules/events.ts`) refuses a delete in three cases,
by design:

1. The user is not an admin (`events:delete` permission). The button is shown only to admins, and SSO users get their
   role from AFS Command Center.
2. The event is not archived yet → "Archive the event before permanently deleting it".
3. The confirmation text is not the event's **link (slug)** → "Confirmation does not match the event link".

Still needed to continue: what appears on screen (no button, endless spinner, or which red message), and the `api` log
lines around the `DELETE /api/events/...` request.
