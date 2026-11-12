# Web widget: spec (2026-11-11)

Goal: a tester on any website the owner builds sends a note with a screenshot of exactly what they see, without leaving the page, and the letter carries enough context (page, browser, viewport) that the owner and a coding agent do not have to ask back.
Installing it on a new site takes one command and one pasted line.

This is slice 1.
Slice 2 adds pointing at an element, console errors and failed requests in the brief, and allowed origins per mailbox (one migration for all three).

## 1. Install

- `<script src="https://<postbox>/widget.js" data-key="pbk_..." async></script>`, printed by `postbox project snippet <slug>` and copied from an empty mailbox in the dashboard.
- Served by the Postbox deployment itself from `public/`, so a redeploy updates every site; no npm package, no build step, works on static sites, WordPress and frameworks alike.
- `widget.js` is a tiny classic loader (works with or without `type="module"`, and when the tag is added late); it queues `Postbox.open()` calls and imports `widget/app.js`, which imports `widget/lib.js`; the screenshot library `widget/snap.js` is imported only when the panel first opens.
- `_headers` gives `/widget.js` and `/widget/*` `Access-Control-Allow-Origin: *` (module imports are CORS requests) and `Cross-Origin-Resource-Policy: cross-origin` (pages with COEP).

## 2. When the button shows

- `data-button="auto"` (default): on development, preview and staging hosts only (localhost, private IPv4, `.test`, `.local`, `.localhost`, `*.pages.dev`, `*.vercel.app`, `*.netlify.app`, `*.workers.dev`, and a first label `staging`, `stage`, `dev`, `preview`, `test` or `qa` followed by `.` or `-`), or in tester mode.
- Tester mode: `?feedback` on any page turns it on for that browser (stored), `?feedback=off` turns it off, which hides the button on staging hosts too; the switch is removed from the reported address.
- `always` and `never` override; `never` still allows `data-postbox-open` elements and `Postbox.open()`, so a site can offer its own "Feedback" link.
- `data-position="left"` starts the button on the left edge.

### Where it sits and how it moves (added 2026-11-12, as in the React Native kit)

- A 44 px round button docked to the right edge at 62% of the viewport height, so it clears chat bubbles, "back to top" buttons and bars pinned to the bottom, which all live in the bottom corners.
- Drag it anywhere: a move over 10 px is a drag, never a click; on release it glides to the nearest side edge and keeps the height; the safe-area insets bound it (CSS `clamp()` over `env()`), so a resize or rotation needs no script.
- The place is stored per site as the side and the height as a share of the viewport, and beats `data-position`; a bad stored value falls back to the default.
- While dragging it lifts (larger shadow, slight scale); pointer capture keeps the drag over iframes and outside the window; `touch-action: none` keeps a drag from scrolling the page; no text gets selected.
- A keyboard click always opens the panel; the button only covers things visually, so keyboard users reach what is under it with Tab and need no keyboard move.
- The panel opens on the button's side, and the button fades out while the panel is open (it stays focusable, so closing gives it focus back).
- On a touch screen it hides while a text field of the page has focus, because the keyboard and the viewport resize would push it over the field.

## 3. The panel

- A native modal `<dialog>` in a shadow root: the top layer beats any z-index, focus is trapped and restored, Esc closes; a click on the scrim closes too.
- Steps: consent once per browser, then the form, then "Sent" for 1.8 s.
- The form: kind (Bug preselected, or the kind passed to `open`), the note (autofocus, Ctrl or Cmd+Enter sends), the screenshot preview with "Include screenshot", image tiles with remove, "Add image" (picker) and paste or drop anywhere in the panel, a line saying what is sent along (screen, browser, viewport), the error line, one primary Send button.
- Limits come from `GET /api/limits` once per page; the screenshot counts as one of `max_attachments`; every image is re-encoded to JPEG 0.7 at most 1600 px on a white background (so transparent PNGs do not turn black), with a 320 px thumbnail of the first image, as in the kit.
- The note and kind are kept as a draft per key until a send succeeds; a failed send keeps everything and says why (offline, rate limit, set-up, too large, bad image, server).
- Language: `data-lang`, else `<html lang>`, else the browser; Vietnamese or English.
- Theme: `data-theme`, else light or dark from the page's own background color, so the panel matches the site rather than the OS.
- Phone width (520 px and below): a bottom sheet with the safe-area insets.

## 4. The screenshot

- Taken with modern-screenshot 4.7.0 (MIT, vendored as `widget/snap.js`), which rebuilds the DOM in an SVG `foreignObject`, so modern CSS such as `oklch()` renders; it starts when the button is pressed, before the panel shows, and the panel never appears in it (the widget's host is filtered out).
- The visible viewport only, at the device pixel ratio capped so the long edge is at most 1600 px.
- Scrolled pages: the cloned `<html>` is shifted with relative positioning, which, unlike a transform, keeps `position: fixed` boxes where they are; `restoreScrollPosition` handles inner scroll boxes (its translation of `<body>` is undone); sticky boxes are measured (current place against their place in the flow, read in the same task and restored through the CSSOM) and placed with relative positioning in the clone.
- `<head>` is not cloned, because a `<meta>` CSP inside it blocks every inline style in the image; `<noscript>` is not cloned, because an image runs no script and would show it.
- Secrets: password values are blanked in the clone, and password fields, `autocomplete="cc-*"` fields and `[data-postbox-mask]` are covered with grey boxes in the image.
- Two patches in the library, each marked "postbox patch": `@import` rules were parsed into a `<style>` of a temporary document, whose sheet is null under a strict `style-src` (font embedding crashed), now a constructed stylesheet; relative URLs were resolved through a `<base>` in a temporary document, which `base-uri` blocks and reports, now the URL API.
- The library draws through a `data:` image, so a page whose `img-src` does not allow `data:` would get a blank picture; a 1 px `data:` probe (once per page) turns that into an honest "could not capture" before any work is done.
- Limits of the method, shown honestly by the preview: cross-origin images and fonts appear only with CORS and `connect-src`, cross-origin iframes stay blank, native form control appearance is approximated; the tester can untick the screenshot and paste a real one.
- A capture that fails or takes more than 15 s leaves a note in the preview and the rest of the panel working.

## 5. What is sent

- `POST /api/submit`, multipart, unchanged server: `meta` (`kind`, `text`, `platform: "web"`, `screen`, `url`, `device`, `os`, `locale`, `build`, `app_version`, `device_id`), `screenshot`, `photo` files, `thumb`; headers `X-Project-Key` and `X-Device-Id`; `credentials: "omit"` and `referrerPolicy: "no-referrer"`, so the raw address never travels in `Referer`.
- `screen`: `Postbox.setScreen()` when set, else the path (plus a `#/` route) with ids folded to `:id` (digits, UUIDs, hex of 16 or more with a digit, ULIDs, 20 or more letters and digits without dashes); percent-encoding is decoded so Vietnamese slugs read normally.
- `url`: no user name or password, no fragment unless it is a `#/` route, no `feedback` switch, and values of query parameters whose names look secret replaced by `redacted`; at most 2000 characters.
- `device`: browser and version (Edge, Opera, Samsung Internet, Coc Coc, Chrome, Firefox, Safari; in-app browsers of Zalo, Facebook, Instagram and LINE are named), viewport and pixel ratio, for example `Chrome 130 (Zalo in-app) · 360x780 @3x`; `os` from the user agent (Windows and macOS versions are frozen there, so only the name).
- `device_id`: 16 random bytes in localStorage (`crypto.getRandomValues`, which works on plain http, for example a site opened by LAN IP); storage that throws falls back to memory.

## 6. Robustness on someone else's page

- Shadow root plus a constructed stylesheet and CSSOM only: no inline styles, no `innerHTML` (Trusted Types), nothing for a strict CSP to block.
- The host element is `display: contents !important`, so page rules such as `div { padding }` cannot give it a box; every text property is set explicitly inside, since inherited properties still cross the shadow boundary.
- The host is appended to `<html>`, not `<body>`, so libraries that replace the body on navigation (Turbo, pjax) keep it.
- Presses, focus moves, keys and scrolls inside the widget stop at the host (bubble phase) and Esc stops in the window's capture phase, so the page's open dialogs, sheets, popovers and menus stay open for the screenshot, Esc closes only the panel, and the page's scroll lock does not block the panel.
- This covers libraries that listen on `document` in the bubble phase, such as Radix, MUI's ClickAwayListener and Bootstrap dropdowns; libraries that listen for presses in the capture phase (Headless UI, React Aria) still close their layer when the button is pressed.
- Loading twice is a no-op; a missing `data-key` warns in the console and does nothing.

## 7. Dashboard and CLI

- An empty mailbox says how to start and offers "Copy website snippet".
- Source facet: "From testers" (kit and widget, `source=app`) and "Added by hand" (`source=web`); the API values stay.
- Build shows `1.2 (34)` with both values and the single value otherwise (it showed `(e2e-1)`); the same rule in the dashboard brief and the CLI brief; the dashboard brief also lists `locale`, like the CLI.
- The URL in a letter is a link that opens in a new tab.
- `postbox project snippet <slug>` prints the tag with the configured Postbox URL.

## 8. Checks

- `test/widget.test.ts`: hosts, tester mode (on, off, unset), button position (drag threshold, docking, stored place), address cleaning, screen names, user agents, meta limits, error messages, both languages complete, limits and timeouts.
- The dashboard itself as a heavy page (about 1300 elements, `img-src 'self' blob:`): the probe reports the capture as impossible in about 0.1 s; before the probe, the capture took about 0.7 s and came back blank.
- End to end, against `wrangler pages dev` and a site on another origin with `default-src 'self'` and `style-src 'self'`: sticky header, fixed chat button, inner scroll box, password and card fields, a masked paragraph, a hostile `div` rule, `oklch()` colors; consent, draft, the site's own `data-postbox-open` link, images by picker and paste, the image limit, every error path, phone width, a dark page, keyboard focus, a production host with and without tester mode over plain http, and the letters in the dashboard.
