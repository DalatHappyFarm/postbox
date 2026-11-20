# Web widget: spec (2026-11-11)

Goal: a tester on any website the owner builds sends a note with a screenshot of exactly what they see, without leaving the page, and the letter carries enough context (page, browser, viewport) that the owner and a coding agent do not have to ask back.
Installing it on a new site takes one command and one pasted line.

This is slice 1.
Slice 2 adds pointing at an element (since 2026-11-20 marking several elements and areas, section 5b), console errors and failed requests in the brief, the tester's last steps on the page (2026-11-20, section 5b), and allowed origins per mailbox.
Allowed origins shipped first (2026-11-12, migration `0005_allowed_origins.sql`), see section 1; the other two follow the same day (migration `0007_page_context.sql`), see section 5b.

## 1. Install

- `<script src="https://<postbox>/widget.js" data-key="pbk_..." async></script>`, printed by `postbox project snippet <slug>` and copied from an empty mailbox in the dashboard.
- Served by the Postbox deployment itself from `public/`, so a redeploy updates every site; no npm package, no build step, works on static sites, WordPress and frameworks alike.
- `widget.js` is a tiny classic loader (works with or without `type="module"`, and when the tag is added late); it queues `Postbox.open()` calls and imports `widget/app.js`, which imports `widget/lib.js`; the screenshot library `widget/snap.js` is imported only when the panel first opens.
- `_headers` gives `/widget.js` and `/widget/*` `Access-Control-Allow-Origin: *` (module imports are CORS requests) and `Cross-Origin-Resource-Policy: cross-origin` (pages with COEP).
- Allowed origins: `postbox project origins <slug> https://shop.com https://*.shop.com` limits which websites may send with the mailbox's key (`PATCH /api/projects/:slug`, `{allowed_origins: [...]}`, at most 20).
  A pattern is `scheme://host[:port]`; `*.` matches any subdomain (not the domain itself, and never a whole top-level domain) and `:*` any port, which suits `http://localhost:*`.
  The submit checks the `Origin` header right after the key and before the rate limit, so another website cannot use up the mailbox's hourly allowance; it answers 403 `origin not allowed`, the panel shows its setup message and keeps the draft, and the console names the origin to add.
  An empty list allows any origin (the default, so existing installs keep working), and a request without `Origin` (native apps, scripts) is accepted: browsers enforce the list, scripts can still send, and the rate limits stay the protection there.

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
- Steps: consent once per browser, then the form, then "Sent" with the letter number from the answer (`Letter #254`, `Mã thư #254`) for 3.5 s, so the tester can mention it (1.8 s without a number).
- The form: kind (Bug preselected, or the kind passed to `open`), the note (autofocus, Ctrl or Cmd+Enter sends), the screenshot preview with "Include screenshot", image tiles with remove, "Add image" (picker) and paste or drop anywhere in the panel, a line saying what is sent along (screen, browser, viewport), the error line, one primary Send button.
- Limits come from `GET /api/limits` once per page; the screenshot counts as one of `max_attachments`; every image is re-encoded to JPEG 0.7 at most 1600 px on a white background (so transparent PNGs do not turn black), with a 320 px thumbnail of the first image, as in the kit.
- The note and kind are kept as a draft per key until a send succeeds; a failed send keeps everything and says why (offline, rate limit, set-up, too large, bad image, server).
- Language: the first of `data-lang`, `<html lang>` and the browser's languages that the widget speaks (the whole tag such as `zh-tw` first, then its language), else English; Vietnamese and English so far, and adding one is one more entry in `STRINGS`.
  It is picked again each time the panel opens, so a site that switches language without a reload is followed, and the widget's host gets the `lang` attribute, so screen readers read the panel in its own language.
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

## 5b. The page around the note (slice 2)

The point is that an agent fixing a web letter cannot open the tester's console or see what they meant by "this button".

**Recent errors and failed requests.**
- Recorded only where the button shows (tester mode, staging hosts): on a live site's ordinary visitors the widget wraps nothing, so `fetch`, `XMLHttpRequest` and `console.error` stay native.
- What: uncaught errors (message and `file:line:column`), unhandled rejections, `console.error`, elements whose resource did not load (`<img>`, `<script>`, `<link>`), and `fetch` or XHR requests that answered 400 or more or got no answer (aborts are not errors).
- Requests to Postbox itself and everything during a screenshot (the library fetches images and fonts) are left out.
- The newest 20 are kept in memory for the page's life; each message is cut to 300 characters and every URL is cleaned like the page address (secret query values redacted).
- `fetch` returns the page's own promise chain: same answer, same rejection, and a rejection the page leaves unhandled still reports as one; XHR `open` is called with the page's own arguments, so a missing `async` stays asynchronous.
- Sent as `meta.logs`, `[{kind, message, source?, method?, url?, status?, seconds_before}]` with `kind` one of `error`, `rejection`, `console`, `resource`, `request` and `status` 0 for no answer; seconds before sending, so the tester's clock never matters.
- The panel says so in "Sent along" (`recent errors (6)`), and the consent text names the page's recent errors; the consent key moved to `v2`, so testers are asked once more.

**Mark the problem (2026-11-20, replaces "Point at the problem").**
- One mode, two gestures: a click (or tap) marks the element under it, a drag of more than 10 px draws a box around an area; the tester can mark up to 9 parts in one go, each numbered in the order it was made.
- An area is for what is not one element: a gap, a crooked row, text spilling out, an embedded map, payment form or video, a canvas chart.
- "Mark the problem" under the screenshot closes the panel (its state stays) and covers the page with a layer and a bar at the top: "Click a part or drag a box" ("Tap ..." on touch screens), Undo and Done.
- Moving the pointer outlines the element under it with a short name (`button.pay`, `#cart`); a marked element gets a red frame with 4 px of room, an area a dashed one, and each a numbered red circle at the first corner that no earlier number covers.
- Clicking a marked element again unmarks it, pressing a number removes its mark, Undo (or Cmd or Ctrl+Z, Backspace) removes the last one; a 10th mark is refused with "Up to 9 marks"; Esc and Done both keep the marks and bring the panel back.
- Hide mode: the bar has a two-button switch before Undo, "Mark" and "Hide" (`aria-pressed`), and Mark is selected each time marking starts.
  Testers on staging sites with real customer data use it to cover private data in the screenshot before sending.
- In Hide mode the same gestures cover part of the screenshot instead of marking it: a click hides the box of the element under it (rounded outwards, so no edge pixel of it stays), a drag hides the dragged box.
  At most 20 boxes (`MAX_HIDES`) can be hidden, and a 21st is refused with "Up to 20 hidden areas"; they do not count toward the 9 marks.
- A hidden box is solid grey (`#8e8e93`, the grey of the covered password fields) on the page and in the screenshot, exactly what will be sent, and has no number.
  On the page it is a button that removes itself when pressed ("Show again"), in both modes; Undo removes the last entry of either kind, mark or hidden box.
- The panel adds a muted line after the list of marks, "Hidden from the screenshot (2)", and its button reads "Mark more" by the number of marks, not of hidden boxes.
- Hidden boxes never leave the browser: `meta.marks` holds only elements and areas, and a mark whose frame overlaps a hidden box sends no `text` and an `html` with only `id` and `class`, because it may sit on what the tester hid.
  That is decided when sending, so a box hidden after the mark counts too.
- The layer takes every press, so nothing on the page opens, submits or closes; it also holds the page still (wheel, scroll keys and one-finger touch moves are cancelled, and any other scroll is undone), so a phone draws with one finger and two fingers still pinch-zoom.
- The page holds the place where the screenshot was taken (the scroll position from the moment the button was pressed is restored first), because the marks are drawn on that screenshot rather than on a new one: a toast or an error message that has gone by the time the tester is done is still in the picture, and marking costs no capture wait.
- Keys while marking reach none of the page's own listeners; focus starts on Done and Tab stays in the bar.
- The panel lists the marks ("1 button.pay "Pay"", "2 Area in div.cart") with a remove button each, under "Mark more"; a click on the scrim no longer closes the panel while it holds marks or images (the close button and Esc still do).
- A masked part never reaches a mark: an element inside one (also across the shadow roots of the page's components) or one that contains one sends no text, and a masked element sends only its `id` and `class`.
- If the page removes the widget while the tester is marking, the next key or scroll gives the page its keys and scrolling back.
- Sent as `meta.marks`, `[{type, selector, html?, text?, style?, rect}]` in the order of their numbers: `type` is `element` or `area`; `selector` is tag names with `:nth-of-type`, from the nearest hand-written id, as short as stays unique (generated ids such as React's `:r1:` are skipped), and inside a page component's open shadow root the host's selector, `>>>`, then the one inside it; for an area it names the smallest element around the box; `html` is the opening tag with `id`, `class`, `name`, `type`, `role`, `aria-label`, `title`, `alt`, `placeholder`, a cleaned `href` and `data-testid`, never a value; `text` is an element's visible text, 120 characters, left out for areas, form fields and masked parts; `rect` is `{x, y, w, h}` in viewport pixels.
- `style` (elements only, not areas) is the element's computed style in one line of at most 500 characters, so an agent fixing a visual bug has its real size, color and spacing without reproducing it: `font: 600 16px/24px Inter; color: rgb(255, 255, 255); background: rgb(196, 98, 22); padding: 10px; border-radius: 8px; display: block`.
  Font (weight, size, line height, first family), color and display are always there; the rest is left out when it is nothing to see: background when fully transparent, padding and margin when all four sides are `0px`, a border when no side is drawn, the border radius when all four corners are `0px`, opacity when it is 1.
  Padding, margin and radius are the shortest 1 to 4 value shorthand; a border is one value when the four sides are equal, else one `border-top` and so on for each side that is drawn.
- Limit of the method: a page's own native modal `<dialog>` sits in the top layer above the marking layer and makes the rest of the page inert, so marking does not work while one is open (portal-based dialogs such as Radix and MUI are fine).

**Steps before sending (2026-11-20).**
- An agent fixing a web letter cannot ask the tester how they got there, so the widget keeps the tester's last steps on the page and sends them with the letter.
- Recorded by the same recorder as the errors: only where the button shows (tester mode, staging hosts), in memory for the page's life, never stored in the browser; the newest 10 are kept (`TRAIL_MAX`).
- Four kinds.
  `load` is the cleaned page address, once, when the recorder starts.
  `navigate` follows `history.pushState`, `history.replaceState`, `popstate` and `hashchange`, and is recorded only when the cleaned address differs from the last one recorded.
  `click` and `change` are below.
- `history.pushState` and `history.replaceState` are wrapped the way `fetch` is: the original is called with the page's own `this` and arguments and its value is returned.
- The click and change listeners sit on the window in the capture phase and never stop, cancel or change an event.
- A `click` is the closest interactive element (`a`, `button`, `[role="button"]`, `input`, `select`, `textarea`, `label`, `summary`) around the first element under the press, else that element, with its short name (`button.pay`, `#cart`) and its visible text (whitespace collapsed, 60 characters).
  A press inside the widget (the button, the panel, the marking layer) is not recorded.
- The text is left out for form fields, for anything inside a masked part (the same rule the marks use, also across the shadow roots of the page's components) and for an element that contains a masked part.
- A `change` is a changed `input`, `textarea` or `select` outside the widget, named by its hand-written id, else `input[name="email"]` (the name attribute with quotes and backslashes dropped, at most 60 characters), else its tag and classes.
- What is never recorded: a typed or chosen value, and key presses.
- Sent as `meta.trail`, `[{kind, name?, text?, url?, seconds_before}]`, oldest first, with seconds before sending like `logs`.
- The panel says so in "Sent along" (`your last steps (4)`), and the consent text names the last clicks, "never what you type"; the consent key moved to `v3`, so testers are asked once more.

**Server, dashboard, CLI.**
- `lib/context.ts` keeps only valid entries and cuts every string; a bad value is dropped, never a reason to refuse the letter.
- Every stored one-line value (meta fields, logs, marks) has its control characters and line breaks turned into spaces and any half of a surrogate pair (a cut through an emoji) turned into U+FFFD; the note keeps tabs and line breaks only.
  Postgres refuses NUL and half pairs in json and text, which lost such letters with a 500, and a line break in a one-line value could forge a heading in a brief.
  That also caps a stored character at 3 bytes, so nine marks at their longest (33,525 bytes, 47,142 with a 500-character `style` each) fit their column check (raised from 40,000 to 60,000 by `0013_marks_style.sql`) and 20 logs at their longest (68,540 bytes) fit theirs (raised to 80,000 by `0010_logs_size.sql`; 20,000 refused real letters), and so do ten steps at their longest (21,820 bytes, check at 30,000).
- `meta` above 256 KB is refused with 413 before it is parsed.
- `cleanTrail` keeps the newest 10 steps whose `kind` is `load`, `navigate`, `click` or `change`; a `load` or `navigate` needs a `url` (500 characters), a `click` or `change` a `name` (120 characters), `text` is cut to 80 characters, and `seconds_before` is as in the logs; an invalid step is dropped, and a trail with none left is `null`.
- Stored as `feedback.logs`, `feedback.marks` (jsonb, size-checked, migration `0009_marks.sql`) and `feedback.trail` (jsonb, migration `0012_trail.sql`); returned on the letter (`GET /api/feedback/:id`), not in lists.
- The Telegram message of a letter adds the number of marks to its line (`Bug · /checkout · web · 2 marks`, `1 mark`, nothing for none), counted from `feedback.marks` or the single old `element` as one, so the owner knows from the phone whether the tester pointed at something.
- The single `meta.element` of widgets cached before marks arrives as the first mark, and letters stored with `feedback.element` are read as one mark; the old column is no longer written and can be dropped once copied.
- The dashboard shows "Marked" in the context table, one numbered row per mark (the tooltip of its selector is the opening tag and, on the next line, the style), and "Page errors and failed requests (n)" under it (open when there are five or fewer); the copied brief and the CLI brief carry the note in a code fence longer than any backtick run in it (so no line of it can start a section the agent would take for the owner's), every tester value on its own line, a "Marked on the page (n)" section after the text, one numbered line per mark with its selector and tag in code spans (and, indented under it, `style:` and the style in a code span), and a "Page errors and failed requests" section, one line per entry.
- The dashboard also shows "Steps before sending (n)" above the page errors, always open, one row per step: the verb (opened, went to, clicked, changed), the name and text or the address, and the seconds before sending.
- The brief has a "Steps before sending (n)" section after "Marked on the page" and before "Decision for the agent", oldest first, one line per step; every tester value is on one line and every name is in a code span:
  ```
  ## Steps before sending (4)

  - 45 s before sending: opened https://shop.test/cart
  - 12 s before sending: went to https://shop.test/checkout
  - 8 s before sending: clicked `button.pay` "Pay"
  - 5 s before sending: changed `input[name="email"]`
  ```

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
- `postbox project snippet <slug>` prints the tag with the configured Postbox URL; `postbox project origins <slug> [origin ...] [--any]` prints, replaces or clears the allowed origins.

## 8. Checks

- `test/widget.test.ts`: hosts, tester mode (on, off, unset), button position (drag threshold, docking, stored place), address cleaning, screen names, user agents, meta limits, error messages, every language complete (each string present and not empty, each `{n}` kept), the language pick, mark frames and numbers, form field names and the 10 steps kept, hidden boxes (their limit and where they meet a frame), the computed style summary, limits and timeouts.
- The dashboard itself as a heavy page (about 1300 elements, `img-src 'self' blob:`): the probe reports the capture as impossible in about 0.1 s; before the probe, the capture took about 0.7 s and came back blank.
- End to end, against `wrangler pages dev` and a site on another origin with `default-src 'self'` and `style-src 'self'`: sticky header, fixed chat button, inner scroll box, password and card fields, a masked paragraph, a hostile `div` rule, `oklch()` colors; consent, draft, the site's own `data-postbox-open` link, images by picker and paste, the image limit, every error path, phone width, a dark page, keyboard focus, a production host with and without tester mode over plain http, and the letters in the dashboard.
