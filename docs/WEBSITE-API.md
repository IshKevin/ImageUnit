# Website integration API

Administrators register a website in **Console → Websites** and receive a key once (`iu_live_…`). Send it as `Authorization: Bearer <key>` **from your server**. Do not embed the key in browser code; instead pass the returned `urls` (signed, expiring) to the browser.

Only events that are **active, not expired, and not password-protected** are exposed, and only those in the key's allow-list if one is set. Revoking a key blocks it and every media link it issued, immediately.

| Scope | Grants |
|---|---|
| `events:read` | `GET /api/v1/events`, `GET /api/v1/events/:idOrSlug` |
| `galleries:read` | `GET /api/v1/events/:id/galleries` |
| `images:read` | `GET /api/v1/events/:id/photos?galleryId=&page=&pageSize=` and thumbnail/preview URLs |
| `downloads:read` | download URLs (also subject to the event/gallery download policy) |

```bash
curl -H "Authorization: Bearer $IU_KEY" https://api.example.com/api/v1/events
```
```json
{ "items": [{ "id": "…", "slug": "kigali-marathon-2026", "name": "Kigali Marathon 2026", "date": "2026-06-20",
              "location": "Kigali", "downloadPolicy": "preview", "expiresAt": "…", "publicUrl": "https://photos.example.com/e/kigali-marathon-2026" }],
  "total": 1, "page": 1, "pageSize": 25 }
```
Administrators can see all of this per event in the console (**Events → an event → Developer**): the exact endpoints, copy-ready cURL/JavaScript/Python snippets, which websites can reach the event, and a "Try it" preview of the real response for any website.

Photo items include `urls.thumbnail`, `urls.preview` and (when permitted) `urls.download`; they are valid for one hour — re-request the list to refresh. Errors are `{ "error": { "code", "message" } }` with 401 (bad key), 403 (revoked/scope/origin), 404, 429 (rate limit; per-key, default 600/min).
