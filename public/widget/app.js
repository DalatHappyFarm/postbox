// Postbox web widget: floating button, feedback panel, viewport screenshot, submit. Loaded by /widget.js.
// Everything lives in one shadow root, styled through a constructed stylesheet and the CSSOM only,
// so it works under a strict CSP (no inline styles, no innerHTML) and the page's CSS cannot reach it.
import {
  STRINGS, DEFAULT_LIMITS, MAX_EDGE, JPEG_QUALITY, THUMB_EDGE, THUMB_QUALITY,
  pickLang, readLimits, showButton, testerFlag, cleanUrl, normalizeScreen, describe, buildMeta, errorKey, sendTimeout, slotsLeft, resizeDims,
} from "./lib.js";

const KINDS = ["bug", "idea", "other"];
const MAX_THUMB_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 15_000;
const SHIFT = "data-postbox-shift";
const MASK = 'input[type="password"], [autocomplete^="cc-"], [data-postbox-mask]';
const KEY = { consent: "postbox.consent.v1", device: "postbox.device-id.v1", tester: "postbox.tester.v1", draft: "postbox.draft.v1:" };

// localStorage can be missing or throw (private mode, blocked site data): fall back to memory for this page.
const memory = new Map();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return memory.get(k) ?? null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { memory.set(k, v); } },
  del: (k) => { try { localStorage.removeItem(k); } catch { memory.delete(k); } },
};

function deviceId() {
  let id = store.get(KEY.device);
  if (!id) {
    // getRandomValues works on plain http too (a site opened by LAN IP), randomUUID does not.
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    store.set(KEY.device, id);
  }
  return id;
}

// ---------- DOM helpers (no innerHTML, so Trusted Types pages work) ----------

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}
const ICONS = {
  bubble: "M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5.5v13M5.5 12h13",
  check: "M5.5 12.5l4 4 9-9.5",
};
function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name]);
  s.append(p);
  return s;
}

const CSS = `
:host { all: initial; }
:host { --bg: #fff; --fg: #1f1f21; --muted: #6e6e73; --line: #e3e3e1; --soft: #f3f3f2; --focus: #1868db; --danger: #c4314b; --ok: #2f8f4e;
  --fab: #1f1f21; --fab-fg: #fff; --shadow: 0 12px 40px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08); --scrim: rgba(0,0,0,.14); color-scheme: light; }
:host([data-postbox-theme="dark"]) { --bg: #1c1c1e; --fg: #f2f2f3; --muted: #a1a1a6; --line: #3a3a3c; --soft: #2c2c2e; --focus: #5b9bff; --danger: #ff6b81; --ok: #4cc777;
  --fab: #f2f2f3; --fab-fg: #1f1f21; --shadow: 0 12px 40px rgba(0,0,0,.55); --scrim: rgba(0,0,0,.4); color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.fab, .panel { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--fg);
  letter-spacing: normal; word-spacing: normal; text-transform: none; text-align: start; text-indent: 0; text-shadow: none; white-space: normal;
  visibility: visible; direction: ltr; -webkit-font-smoothing: antialiased; }
svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; white-space: nowrap; }

.fab { position: fixed; z-index: 2147483647; right: calc(20px + env(safe-area-inset-right, 0px)); bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center;
  background: var(--fab); color: var(--fab-fg); box-shadow: var(--shadow); opacity: .9; transition: opacity .15s, transform .15s; }
.fab:hover { opacity: 1; transform: translateY(-1px); }
.fab:active { transform: scale(.96); }
.fab.left { right: auto; left: calc(20px + env(safe-area-inset-left, 0px)); }
.fab svg { width: 22px; height: 22px; }

.panel { position: fixed; margin: 0; padding: 0; inset: auto calc(20px + env(safe-area-inset-right, 0px)) calc(76px + env(safe-area-inset-bottom, 0px)) auto;
  width: min(380px, calc(100vw - 40px)); max-height: calc(100dvh - 100px); border: 1px solid var(--line); border-radius: 16px;
  background: var(--bg); box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; }
.panel:not([open]) { display: none; }
.panel.left { inset: auto auto calc(76px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px)); }
.panel::backdrop { background: var(--scrim); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 10px 4px 18px; }
h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.x { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; color: var(--muted); }
.x:hover { background: var(--soft); color: var(--fg); }
.body { padding: 8px 18px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.body p { margin: 0; }

.kinds { display: flex; gap: 2px; margin: 0; padding: 2px; border: 0; border-radius: 10px; background: var(--soft); min-width: 0; }
.kinds label { flex: 1; position: relative; }
.kinds input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.kinds span { display: block; padding: 6px 8px; border-radius: 8px; text-align: center; font-weight: 500; color: var(--muted); }
.kinds input:checked + span { background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.14); }
.kinds input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 1px; }

textarea { display: block; width: 100%; min-height: 96px; max-height: 40vh; resize: vertical; margin: 0; padding: 10px 12px; line-height: 1.45;
  border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
textarea::placeholder { color: var(--muted); opacity: 1; }
textarea:focus { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }

.shot { height: 150px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; overflow: hidden; }
.shot img { display: block; width: 100%; height: 100%; object-fit: contain; transition: opacity .15s; }
.shot.off img { opacity: .3; }
.shot .note { padding: 0 16px; color: var(--muted); font-size: 13px; text-align: center; }
.shot.wait { background: linear-gradient(100deg, var(--soft) 30%, var(--bg) 50%, var(--soft) 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { to { background-position: -150% 0; } }
.check { display: flex; align-items: center; gap: 8px; width: fit-content; cursor: pointer; user-select: none; }
.check input { width: 16px; height: 16px; margin: 0; accent-color: var(--fg); cursor: pointer; }

.tiles { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tile { position: relative; width: 56px; height: 56px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--soft); }
.tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tile button { position: absolute; top: 3px; right: 3px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center;
  background: rgba(0,0,0,.62); color: #fff; }
.tile button svg { width: 14px; height: 14px; stroke-width: 2.2; }
.add { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: 1px dashed var(--muted); border-radius: 8px;
  background: transparent; font-weight: 500; }
.add:hover:not(:disabled) { background: var(--soft); }
.add:disabled { opacity: .45; cursor: default; }
.add svg { width: 16px; height: 16px; }
.hint { color: var(--muted); font-size: 13px; }
@media (pointer: coarse) { .hint { display: none; } }

.ctx { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.err { color: var(--danger); font-size: 13px; }
.primary { width: 100%; height: 44px; border: 0; border-radius: 10px; background: var(--fg); color: var(--bg); font-size: 15px; font-weight: 600; }
.primary:hover:not(:disabled) { opacity: .9; }
.primary:disabled { opacity: .55; cursor: default; }
.done { display: grid; justify-items: center; gap: 10px; padding: 18px 0 8px; text-align: center; font-weight: 500; }
.done .mark { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--ok); color: #fff; }
.done svg { width: 24px; height: 24px; stroke-width: 2.4; }
.panel.drag::after { content: attr(data-drop); position: absolute; inset: 8px; display: grid; place-items: center; padding: 16px; text-align: center;
  border: 2px dashed var(--focus); border-radius: 12px; background: var(--bg); font-weight: 600; pointer-events: none; }

@media (max-width: 520px) {
  .panel, .panel.left { inset: auto 0 0 0; width: 100%; max-width: none; max-height: 92dvh; border-width: 1px 0 0; border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px); }
  .panel::backdrop { background: rgba(0,0,0,.32); }
}
@media (prefers-reduced-motion: reduce) { .fab, .shot img { transition: none; } .shot.wait { animation: none; } }
`;

// ---------- images ----------

function encode(canvas, quality) {
  return new Promise((res, rej) => {
    try { canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality); } catch (e) { rej(e); }
  });
}

/** Any image the browser can decode, as a JPEG at most `max` px on the long edge, on white (no black where it was transparent). */
async function toJpeg(blob, max, quality) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => createImageBitmap(blob));
  const { w, h: hh } = resizeDims(bmp.width, bmp.height, max);
  const c = h("canvas", { width: w, height: hh });
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, hh);
  g.drawImage(bmp, 0, 0, w, hh);
  bmp.close?.();
  return encode(c, quality);
}

const TRANSPARENT = /^transparent$|rgba\(.*,\s*0\)$|\/\s*0\)$/;
function pageBackground() {
  const a = getComputedStyle(document.documentElement).backgroundColor;
  const b = document.body ? getComputedStyle(document.body).backgroundColor : "";
  return !TRANSPARENT.test(a) ? a : b && !TRANSPARENT.test(b) ? b : "#ffffff";
}
/** Whether a CSS color is dark, read back through a 1 px canvas so any syntax (oklch, color()) works. */
function isDark(color) {
  const g = h("canvas", { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!g) return false;
  g.fillStyle = "#fff";
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return 0.2126 * r + 0.7152 * gr + 0.0722 * b < 110;
}

/** Sticky boxes render at their place in the flow in a clone, so remember how far each one is pushed right now. */
function markSticky(skip) {
  const marked = [];
  const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n === skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  // ponytail: one getComputedStyle per element; cap or index by selector if a huge page makes opening slow.
  for (let n = walk.nextNode(); n && marked.length < 50; n = walk.nextNode()) {
    const pos = getComputedStyle(n).position;
    if (pos !== "sticky" && pos !== "-webkit-sticky") continue;
    const now = n.getBoundingClientRect();
    // Measured static in the same task, restored through the CSSOM: nothing paints, and no style attribute is parsed (strict CSP).
    const hadStyle = n.hasAttribute("style");
    const prev = n.style.getPropertyValue("position"), prio = n.style.getPropertyPriority("position");
    n.style.setProperty("position", "static", "important");
    const flow = n.getBoundingClientRect();
    if (prev) n.style.setProperty("position", prev, prio); else n.style.removeProperty("position");
    if (!hadStyle && !n.style.length) n.removeAttribute("style");
    const dx = now.left - flow.left, dy = now.top - flow.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    n.setAttribute(SHIFT, `${dx} ${dy}`);
    marked.push(n);
  }
  return marked;
}

let snapModule = null;
let dataImages = null;
/** The page draws through a data: image; when its CSP blocks those the result would be blank, so it counts as a failed capture. */
const dataImagesAllowed = () => (dataImages ??= new Promise((res) => {
  const img = new Image();
  img.onload = () => res(true);
  img.onerror = () => res(false);
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}));

/** The visible part of the page as a JPEG, without the widget; secrets are blanked in the clone and covered in the image. */
async function capture(host) {
  const de = document.documentElement;
  const W = de.clientWidth || innerWidth, H = de.clientHeight || innerHeight;
  const sx = scrollX, sy = scrollY;
  const masks = [...document.querySelectorAll(MASK)].map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W);
  const marked = markSticky(host);
  const bodyTransform = document.body ? getComputedStyle(document.body).transform : "none";
  const bg = pageBackground();
  try {
    if (!(await dataImagesAllowed())) throw new Error("the page's img-src does not allow data: images");
    snapModule ??= import(new URL("snap.js", import.meta.url).href);
    const { domToCanvas } = await snapModule;
    const scale = Math.min(devicePixelRatio || 1, MAX_EDGE / Math.max(W, H));
    let timer;
    const canvas = await Promise.race([
      domToCanvas(de, {
        width: W, height: H, scale, backgroundColor: bg, timeout: 5000,
        // <head> would carry a <meta> CSP into the image (blocking every inline style there); <noscript> shows in an image, which runs no script.
        filter: (n) => n !== host && n.nodeName !== "HEAD" && n.nodeName !== "NOSCRIPT",
        // Inner scroll boxes (app shells) keep their scroll position.
        features: { restoreScrollPosition: true },
        // The root is shifted by the page scroll with relative positioning, which (unlike a transform) keeps fixed boxes on screen.
        style: { position: "relative", top: `${-sy}px`, left: `${-sx}px` },
        onCloneEachNode: (c) => { if (c.tagName === "INPUT" && String(c.getAttribute("type")).toLowerCase() === "password") c.setAttribute("value", ""); },
        onCloneNode: (root) => {
          // restoreScrollPosition also translates <body> for the page scroll; the root shift already does that.
          const body = root.querySelector?.("body");
          if (body) body.style.setProperty("transform", bodyTransform);
          for (const el of root.querySelectorAll?.(`[${SHIFT}]`) ?? []) {
            const [dx, dy] = el.getAttribute(SHIFT).split(" ");
            el.removeAttribute(SHIFT);
            for (const [k, v] of [["position", "relative"], ["top", `${dy}px`], ["left", `${dx}px`], ["bottom", "auto"], ["right", "auto"]]) el.style.setProperty(k, v, "important");
          }
        },
      }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("capture timed out")), CAPTURE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const out = h("canvas", { width: canvas.width, height: canvas.height });
    const g = out.getContext("2d");
    g.fillStyle = bg;
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    const k = canvas.width / W;
    g.fillStyle = "#8e8e93";
    for (const r of masks) g.fillRect(Math.floor(r.left * k), Math.floor(r.top * k), Math.ceil(r.width * k), Math.ceil(r.height * k));
    return await encode(out, JPEG_QUALITY);
  } finally {
    for (const n of marked) n.removeAttribute(SHIFT);
  }
}

// ---------- widget ----------

export function start(script, queue = []) {
  const d = script.dataset;
  const key = d.key;
  const origin = new URL(script.src, location.href).origin;
  const t = STRINGS[pickLang(d.lang, document.documentElement.lang, navigator.languages || [navigator.language])];
  const fetchInit = { credentials: "omit", referrerPolicy: "no-referrer" }; // the cleaned URL is sent in meta, never the raw one in Referer

  if (new URLSearchParams(location.search).has("feedback")) {
    if (testerFlag(location.search, false)) store.set(KEY.tester, "1"); else store.del(KEY.tester);
  }
  const tester = store.get(KEY.tester) === "1";
  let screenName = null;
  let limits = null;
  const loadLimits = () => {
    limits ??= fetch(`${origin}/api/limits`, fetchInit).then((r) => (r.ok ? r.json() : null)).then(readLimits).catch(() => { limits = null; return { ...DEFAULT_LIMITS }; });
    return limits;
  };

  const host = h("div", { "data-postbox": "" });
  // The page's CSS still reaches the host element itself; keep it out of the layout whatever the page says about divs.
  host.style.setProperty("display", "contents", "important");
  const root = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  const side = d.position === "left" ? " left" : "";
  const fab = h("button", { class: "fab" + side, type: "button", title: t.button, "aria-label": t.button, onclick: () => open() }, icon("bubble"));
  fab.hidden = !showButton(d.button || "auto", location.hostname, tester);
  const dlg = h("dialog", { class: "panel" + side, "aria-labelledby": "pb-title", "data-drop": t.drop });
  root.append(fab, dlg);
  // On <html>, not <body>: libraries that swap the body on navigation (Turbo, pjax) keep the widget.
  document.documentElement.append(host);
  const theme = () => host.setAttribute("data-postbox-theme", d.theme === "dark" || d.theme === "light" ? d.theme : isDark(pageBackground()) ? "dark" : "light");
  theme();

  // ---------- state ----------
  const S = { step: "form", kind: "bug", shot: null, shotTask: null, include: true, images: [], ctx: null, busy: false, run: 0 };
  let ui = {};
  const draftKey = KEY.draft + key;
  const readDraft = () => { try { return JSON.parse(store.get(draftKey) || "{}") || {}; } catch { return {}; } };
  const saveDraft = () => { const text = ui.text?.value ?? ""; if (text.trim()) store.set(draftKey, JSON.stringify({ kind: S.kind, text })); else store.del(draftKey); };
  const shotOk = () => S.shot instanceof Blob;
  const slots = async () => slotsLeft((await loadLimits()).max_attachments, S.include && S.shot !== "failed", S.images.length);

  function context() {
    const { device, os } = describe(navigator.userAgent, { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints });
    return {
      url: cleanUrl(location.href), screen: screenName || normalizeScreen(location.pathname, location.hash),
      device, os, locale: navigator.language, build: d.build, app_version: d.version, device_id: deviceId(),
    };
  }

  function open(kind) {
    if (dlg.open) { if (KINDS.includes(kind)) setKind(kind); ui.text?.focus(); return; }
    theme();
    const run = ++S.run;
    S.ctx = context();
    const draft = readDraft();
    S.kind = KINDS.includes(kind) ? kind : KINDS.includes(draft.kind) ? draft.kind : "bug";
    S.include = true; S.images = []; S.busy = false;
    S.shot = "pending";
    // Measured before the panel opens; the clone itself skips the widget.
    S.shotTask = capture(host).then(
      (b) => { if (run === S.run) { S.shot = b; S.shotUrl = URL.createObjectURL(b); } },
      (e) => { if (run === S.run) S.shot = "failed"; console.warn("Postbox: screenshot failed.", e); },
    ).then(() => { if (run === S.run) { paintShot(); paintTiles(); } });
    loadLimits();
    S.step = store.get(KEY.consent) === "1" ? "form" : "consent";
    render(draft.text || "");
    dlg.showModal();
  }

  function close() { if (dlg.open) dlg.close(); }
  dlg.addEventListener("close", () => {
    S.run++;
    clearTimeout(S.doneTimer);
    if (S.shotUrl) URL.revokeObjectURL(S.shotUrl);
    S.images.forEach((i) => URL.revokeObjectURL(i.url));
    S.shot = S.shotUrl = null; S.images = [];
    dlg.replaceChildren();
    ui = {};
  });
  // A click on the scrim (outside the panel box) closes, like a sheet.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });

  function setKind(k) { S.kind = k; for (const r of ui.kinds ?? []) r.checked = r.value === k; saveDraft(); }
  function setError(msg) { if (!ui.err) return; ui.err.textContent = msg || ""; ui.err.hidden = !msg; }

  function render(text) {
    const head = h("div", { class: "head" }, h("h2", { id: "pb-title" }, t.title), h("button", { class: "x", type: "button", title: t.close, "aria-label": t.close, onclick: close }, icon("close")));
    let body;
    if (S.step === "consent") {
      body = h("div", { class: "body" }, h("p", {}, t.consent), h("button", {
        class: "primary", type: "button", autofocus: true,
        onclick: () => { store.set(KEY.consent, "1"); S.step = "form"; render(text); ui.text.focus(); },
      }, t.consentOk));
    } else if (S.step === "done") {
      body = h("div", { class: "body" }, h("div", { class: "done", role: "status" }, h("span", { class: "mark" }, icon("check")), t.sent));
    } else {
      body = form(text);
    }
    dlg.replaceChildren(head, body);
  }

  function form(text) {
    ui.kinds = KINDS.map((k) => h("input", { type: "radio", name: "kind", value: k, checked: S.kind === k, onchange: () => setKind(k) }));
    ui.text = h("textarea", {
      id: "pb-text", rows: 4, maxLength: DEFAULT_LIMITS.max_text, placeholder: t.placeholder, value: text, autofocus: true,
      oninput: () => { saveDraft(); setError(""); },
      onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
    });
    loadLimits().then((l) => { if (ui.text) ui.text.maxLength = l.max_text; });
    ui.shot = h("div", { class: "shot" });
    ui.include = h("input", { type: "checkbox", checked: S.include, onchange: () => { S.include = ui.include.checked; paintShot(); paintTiles(); } });
    ui.includeRow = h("label", { class: "check" }, ui.include, t.include);
    ui.tiles = h("div", { class: "tiles" });
    ui.file = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: () => { addFiles(ui.file.files); ui.file.value = ""; } });
    ui.err = h("p", { class: "err", role: "alert", hidden: true });
    ui.send = h("button", { class: "primary", type: "submit" }, t.send);
    const c = S.ctx;
    const f = h("form", { class: "body", novalidate: true, onsubmit: (e) => { e.preventDefault(); send(); } },
      h("fieldset", { class: "kinds" }, h("legend", { class: "sr" }, t.kindLabel), KINDS.map((k, i) => h("label", {}, ui.kinds[i], h("span", {}, t.kinds[k])))),
      h("label", { class: "sr", htmlFor: "pb-text" }, t.textLabel), ui.text,
      ui.shot, ui.includeRow, ui.tiles, ui.file,
      h("p", { class: "ctx" }, `${t.context}: ${[c.screen, c.device].filter(Boolean).join(" · ")}`),
      ui.err, ui.send);
    paintShot();
    paintTiles();
    return f;
  }

  function paintShot() {
    if (!ui.shot) return;
    ui.shot.className = "shot" + (S.shot === "pending" ? " wait" : "") + (shotOk() && !S.include ? " off" : "");
    ui.shot.replaceChildren(
      S.shot === "pending" ? h("span", { class: "sr", role: "status" }, t.capturing)
      : S.shot === "failed" ? h("span", { class: "note" }, t.shotFailed)
      : shotOk() ? h("img", { src: S.shotUrl, alt: t.screenshot }) : "",
    );
    ui.includeRow.hidden = S.shot === "failed";
  }

  async function paintTiles() {
    if (!ui.tiles) return;
    const left = await slots();
    if (!ui.tiles) return;
    const tiles = S.images.map((img, n) => h("div", { class: "tile" },
      h("img", { src: img.url, alt: `${t.image} ${n + 1}` }),
      h("button", { type: "button", title: t.remove, "aria-label": `${t.remove} ${n + 1}`, onclick: () => { URL.revokeObjectURL(img.url); S.images.splice(n, 1); paintTiles(); } }, icon("close"))));
    const add = h("button", { class: "add", type: "button", disabled: left <= 0, title: left <= 0 ? t.full : null, onclick: () => ui.file.click() }, icon("plus"), t.addImage);
    ui.tiles.replaceChildren(...tiles, add, left > 0 ? h("span", { class: "hint" }, t.paste) : "");
  }

  async function addFiles(list) {
    const files = [...(list || [])].filter((f) => !f.type || f.type.startsWith("image/"));
    if (!files.length) return;
    const l = await loadLimits();
    const room = await slots();
    setError(room < files.length ? t.full : "");
    for (const file of files.slice(0, room)) {
      try {
        const blob = await toJpeg(file, MAX_EDGE, JPEG_QUALITY);
        if (blob.size > l.max_image_bytes) throw new Error("too large");
        S.images.push({ blob, url: URL.createObjectURL(blob) });
      } catch {
        setError(t.errors.badImage);
      }
    }
    paintTiles();
  }

  dlg.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length || !ui.tiles) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    addFiles(files);
  });
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  dlg.addEventListener("dragover", (e) => { if (!hasFiles(e) || !ui.tiles) return; e.preventDefault(); dlg.classList.add("drag"); });
  dlg.addEventListener("dragleave", (e) => { if (!dlg.contains(e.relatedTarget)) dlg.classList.remove("drag"); });
  dlg.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dlg.classList.remove("drag"); addFiles(e.dataTransfer.files); });

  function busy(on) {
    S.busy = on;
    if (!ui.send) return;
    ui.send.disabled = on;
    ui.send.textContent = on ? t.sending : t.send;
    ui.text.readOnly = on;
  }

  async function send() {
    if (S.busy || !ui.text) return;
    const text = ui.text.value.trim();
    if (!text) { setError(t.errors.empty); ui.text.focus(); return; }
    const run = S.run;
    setError("");
    busy(true);
    try {
      const l = await loadLimits();
      if (S.include && S.shot === "pending") await S.shotTask; // sent the moment the screenshot is ready
      if (run !== S.run) return;
      const shot = S.include && shotOk() ? S.shot : null;
      const blobs = [...(shot ? [shot] : []), ...S.images.map((i) => i.blob)];
      const bytes = blobs.reduce((n, b) => n + b.size, 0);
      if (blobs.length > l.max_attachments || bytes > l.max_total_bytes) { setError(t.errors.tooLarge); return; }
      const body = new FormData();
      body.set("meta", JSON.stringify(buildMeta({ ...S.ctx, kind: S.kind, text }, l.max_text)));
      if (shot) body.append("screenshot", shot, "screenshot.jpg");
      S.images.forEach((i, n) => body.append("photo", i.blob, `photo-${n + 1}.jpg`));
      if (blobs.length) {
        const th = await toJpeg(blobs[0], THUMB_EDGE, THUMB_QUALITY).catch(() => null);
        if (th && th.size <= MAX_THUMB_BYTES) body.append("thumb", th, "thumb.jpg");
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), sendTimeout(bytes));
      let res;
      try {
        res = await fetch(`${origin}/api/submit`, { ...fetchInit, method: "POST", headers: { "X-Project-Key": key, "X-Device-Id": S.ctx.device_id }, body, signal: ctl.signal });
      } catch {
        if (run === S.run) setError(t.errors.offline);
        return;
      } finally {
        clearTimeout(timer);
      }
      if (run !== S.run) return;
      if (!res.ok) {
        const err = await res.json().then((j) => j.error, () => "");
        if (res.status === 401) console.warn(`Postbox: the server refused the project key (${err}).`);
        setError(t.errors[errorKey(res.status, err)]);
        return;
      }
      store.del(draftKey);
      S.step = "done";
      render("");
      S.doneTimer = setTimeout(close, 1800);
    } finally {
      if (run === S.run) busy(false);
    }
  }

  // Any element with data-postbox-open opens the panel (value: bug, idea or other), so sites need no inline script.
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-postbox-open]") : null;
    if (!el) return;
    e.preventDefault();
    open(el.getAttribute("data-postbox-open") || undefined);
  });

  window.Postbox = { open, setScreen: (name) => { screenName = typeof name === "string" && name.trim() ? name.trim() : null; } };
  for (const [m, arg] of queue) window.Postbox[m]?.(arg);
}
