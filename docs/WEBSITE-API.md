# Website integration API

Administrators register a website in **Console → Websites** and receive a key once (`iu_live_…`). Send it as `Authorization: Bearer <key>` **from your server**. Do not embed the key in browser code; instead pass the returned `urls` (signed, expiring) to the browser.

Only events that are **active, not expired, and not password-protected** are exposed, and only those in the key's allow-list if one is set. Revoking a key blocks it and every media link it issued, immediately.

| Scope | Grants |
|---|---|
| `events:read` | `GET /api/v1/events`, `GET /api/v1/events/:idOrSlug` |
| `galleries:read` | `GET /api/v1/events/:id/galleries` |
| `images:read` | `GET /api/v1/events/:id/media` (alias `/photos`), `GET /api/v1/media?q=&type=&tag=` (search), `GET /api/v1/media/:id`, and thumbnail/preview URLs |
| `downloads:read` | download URLs (also subject to the event/gallery download policy) |
| `collections:read` | `GET /api/v1/collections`, `/collections/{slug}`, `/collections/{slug}/media` |

```bash
curl -H "Authorization: Bearer $IU_KEY" https://api.example.com/api/v1/events
```
```json
{ "items": [{ "id": "…", "slug": "kigali-marathon-2026", "name": "Kigali Marathon 2026", "date": "2026-06-20",
              "location": "Kigali", "downloadPolicy": "preview", "expiresAt": "…", "publicUrl": "https://photos.example.com/e/kigali-marathon-2026" }],
  "total": 1, "page": 1, "pageSize": 25 }
```
Administrators can see all of this per event in the console (**Events → an event → Developer**): the exact endpoints, copy-ready cURL/JavaScript/Python snippets, which websites can reach the event, and a "Try it" preview of the real response for any website.

Event objects also carry a `cover` (the image chosen as the event's cover, or the first photograph when none is chosen): `"cover": { "thumbnail": "…", "preview": "…" }` (null without the `images:read` scope). A dedicated cover image can be hidden from the gallery, so it will not appear in `/media` lists, but its link works.

Photo items include `urls.thumbnail`, `urls.preview` and (when permitted) `urls.download`; they are valid for one hour — re-request the list to refresh. Errors are `{ "error": { "code", "message" } }` with 401 (bad key), 403 (revoked/scope/origin), 404, 429 (rate limit; per-key, default 600/min).


## Photos, videos and the information that comes with them

`/media` returns **photos and videos** (`type: "image" | "video"`; filter with `?type=video`). Every item is self-describing, so a website never needs a second request to learn what it is showing:

```json
{
  "id": "7c1e…", "type": "video",
  "title": "Winner crossing the finish line",      // editor-chosen name; falls back to the file name
  "filename": "C0042.mp4", "downloadName": "Winner crossing the finish line.mp4",
  "description": "First place, men's 10 km",
  "tags": ["finish line", "winner"],
  "width": 1920, "height": 1080, "durationSeconds": 12.4, "takenAt": "2026-06-20T08:14:00Z",
  "photographer": "John Photography",
  "event": { "id": "…", "slug": "kigali-marathon-2026", "name": "Kigali International Marathon 2026",
             "description": "The annual city marathon", "date": "2026-06-20", "location": "Kigali",
             "publicUrl": "https://photos.example.com/e/kigali-marathon-2026" },
  "urls": { "thumbnail": "…", "preview": "…(MP4 for videos)", "download": null }
}
```
`urls.preview` for a video is a web-friendly H.264 MP4 (max 1920 px wide) that plays in any `<video>` element; `urls.thumbnail` is its poster frame. `urls.download` is the original file when the event's download policy allows it.

**Search:** `GET /api/v1/media?q=finish+line&type=video&tag=winner`: every word must match a title, file name, description, tag or event name.

## Collections

A *collection* is a named, curated set of media, usually from several events (for example "Best of 2026" or "Homepage hero"). Editors build them in the console (**Collections**); websites read them:

```bash
curl -H "Authorization: Bearer $IU_KEY" https://api.example.com/api/v1/collections                       # published collections
curl -H "Authorization: Bearer $IU_KEY" https://api.example.com/api/v1/collections/best-of-2026         # name, description, mediaCount
curl -H "Authorization: Bearer $IU_KEY" "https://api.example.com/api/v1/collections/best-of-2026/media?type=image&pageSize=24"
```
Items come in the editor's chosen order, with the same payload as above. Only *published* collections are visible, and a collection only ever shows items the credential could see anyway: media from active, non-password events, not hidden, and within the credential's event allow-list. Without the `images:read` scope the items are returned with `urls: null` (metadata only).
