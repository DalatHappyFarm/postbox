# Attachments: spec (2026-10-17)

Design decisions: testers attach photos from the library and from the camera, besides the automatic screenshot; at most 4 images per feedback for now, and every limit is configurable through variables; security and performance first, no wasted resources.

## 1. Limits (one source of truth: Pages variables)

Set as plain `[vars]` in `wrangler.toml` (not secrets), read by the API with these defaults when absent:

| Variable | Default | Meaning |
|---|---|---|
| `MAX_ATTACHMENTS` | 4 | Images per feedback, screenshot included |
| `MAX_IMAGE_BYTES` | 5242880 | One image after client compression |
| `MAX_TOTAL_BYTES` | 15728640 | All images of one submit together |
| `MAX_THUMB_BYTES` | 65536 | The list thumbnail |
| `MAX_TEXT` | 4000 | Note length |
| `RATE_PER_DEVICE_HOUR` | 20 | Submits per device and IP per hour |
| `RATE_PER_PROJECT_HOUR` | 200 | Submits per project per hour |

`GET /api/limits` (public, no key, `cache-control: public, max-age=3600`) returns `{max_attachments, max_image_bytes, max_total_bytes, max_text, image_types: ["image/jpeg", "image/png"]}` so clients follow a change without a new app build.
Client values never weaken the server: the server enforces every limit itself.

## 2. Submit (multipart, new) and JSON (kept)

`POST /api/submit` with header `X-Project-Key` and, from kit 0.2.0, `X-Device-Id` (the per-install random id), so the rate limit runs per device before the body is read; without it the limit is per IP.

Multipart form fields:
- `meta`: JSON string with `kind, text, screen, app_version, build, platform, device, os, locale, url, device_id` (same rules as today).
- `screenshot`: optional, one image file.
- `photo`: zero or more image files, in display order.
- `thumb`: optional, one small JPEG of the first image, at most `MAX_THUMB_BYTES`, used by the dashboard list.

Rules, checked in this order, cheapest first:
1. Project key valid, then rate limit, before reading the body.
2. `Content-Length` present and at most `MAX_TOTAL_BYTES + MAX_THUMB_BYTES + 64 KB`; otherwise 411 or 413 without reading the body.
3. Count of `screenshot` + `photo` files at most `MAX_ATTACHMENTS`; each at most `MAX_IMAGE_BYTES`; the sum at most `MAX_TOTAL_BYTES`.
4. Type from magic bytes only (JPEG or PNG); the client's content type and file name are ignored.
5. JPEG metadata stripped on the server (drop APP1 to APP15 and COM segments), so EXIF such as GPS location never reaches storage, even if a client forgets.
6. R2 writes run in parallel; keys `<project-slug>/<feedback-id>/<n>.<ext>` and `<project-slug>/<feedback-id>/thumb.jpg`; any failure deletes what was written and the row.

The JSON body with one base64 `screenshot` stays accepted (kit 0.1.0 in the field), stored the same way as attachment 0.

## 3. Data

Migration `0002_attachments.sql`:
- `attachments (feedback_id references feedback on delete cascade, position smallint, kind text check in ('screenshot', 'photo'), r2_key text, bytes int, content_type text, primary key (feedback_id, position))`.
- `feedback.thumb_key text` and `feedback.attachment_count smallint default 0` (the list needs no join).
- Existing `screenshot_key` rows are copied into `attachments` as position 0; the column stays read-only for one release, then a later migration drops it.

## 4. Admin API

- `GET /api/feedback` items gain `attachment_count` and `has_thumb`.
- `GET /api/feedback/:id` gains `attachments: [{position, kind, bytes, content_type}]`.
- `GET /api/feedback/:id/attachments/:position` and `GET /api/feedback/:id/thumb` stream from R2 with `cache-control: private, max-age=86400, immutable` and the R2 ETag (content never changes).
- `GET /api/feedback/:id/screenshot` stays as an alias of the first attachment.

## 5. Clients

- Kit 0.2.0: screenshot captured to a temp file (no base64 in JS); "Add photo" offers Library (multi-select up to the remaining slots) and Camera; every image resized to at most 1600 px on the long edge, JPEG 0.7, which also drops EXIF and bakes the orientation; a 320 px thumbnail of the first image; upload as multipart with file URIs; limits from `/api/limits`, fetched once per app session.
- Dashboard: the list shows the thumbnail and "+N" for more images, loaded lazily only for visible rows; the detail shows all images in order, full size on click.
- CLI: `postbox show` downloads every attachment to the temp folder and prints each path.
