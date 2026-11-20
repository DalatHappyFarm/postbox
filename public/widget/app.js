// Postbox web widget: floating button, feedback panel, viewport screenshot, submit. Loaded by /widget.js.
// Everything lives in one shadow root, styled through a constructed stylesheet and the CSSOM only,
// so it works under a strict CSP (no inline styles, no innerHTML) and the page's CSS cannot reach it.
import {
  STRINGS, DEFAULT_LIMITS, MAX_EDGE, JPEG_QUALITY, THUMB_EDGE, THUMB_QUALITY,
  pickLang, readLimits, showButton, testerFlag, initialFab, snapFab, isDrag, cleanUrl, normalizeScreen, describe, buildMeta, errorKey, sendTimeout, slotsLeft, resizeDims,
  errText, pushLog, logsForSend, cssPath, openingTag, shortName, MAX_MARKS, BADGE, boxBetween, frameOf, placeBadges, holds,
} from "./lib.js";

const KINDS = ["bug", "idea", "other"];
const MAX_THUMB_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 15_000;
const SHIFT = "data-postbox-shift";
const RED = "#e5484d";
const MASK = 'input[type="password"], [autocomplete^="cc-"], [data-postbox-mask]';
const KEY = { consent: "postbox.consent.v2", device: "postbox.device-id.v1", tester: "postbox.tester.v1", draft: "postbox.draft.v1:", fab: "postbox.button-position.v1" };

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
  target: "M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M12 6.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11z",
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
  --fab: #1f1f21; --fab-fg: #fff; --shadow: 0 12px 40px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08); --lift: 0 18px 48px rgba(0,0,0,.24), 0 4px 12px rgba(0,0,0,.12);
  --scrim: rgba(0,0,0,.14); color-scheme: light; }
:host([data-postbox-theme="dark"]) { --bg: #1c1c1e; --fg: #f2f2f3; --muted: #a1a1a6; --line: #3a3a3c; --soft: #2c2c2e; --focus: #5b9bff; --danger: #ff6b81; --ok: #4cc777;
  --fab: #f2f2f3; --fab-fg: #1f1f21; --shadow: 0 12px 40px rgba(0,0,0,.55); --lift: 0 18px 48px rgba(0,0,0,.7); --scrim: rgba(0,0,0,.4); color-scheme: dark; }
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

/* Docked to a side edge; --pb-y is the height of its centre as a share of the viewport, kept inside the safe area. */
.fab { position: fixed; z-index: 2147483647; right: calc(12px + env(safe-area-inset-right, 0px)); bottom: auto;
  top: clamp(calc(env(safe-area-inset-top, 0px) + 12px), calc(var(--pb-y, .62) * 100% - 22px), calc(100% - env(safe-area-inset-bottom, 0px) - 56px));
  width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center;
  background: var(--fab); color: var(--fab-fg); box-shadow: var(--shadow); opacity: .9; transition: opacity .15s, transform .15s, box-shadow .15s;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.fab:hover { opacity: 1; transform: translateY(-1px); }
.fab:active { transform: scale(.96); }
.fab.left { right: auto; left: calc(12px + env(safe-area-inset-left, 0px)); }
.fab.dragging { opacity: 1; transform: scale(1.08); box-shadow: var(--lift); cursor: grabbing; }
.fab.away { opacity: 0; pointer-events: none; }
.fab.typing { visibility: hidden; }
.fab svg { width: 22px; height: 22px; }

.panel { position: fixed; margin: 0; padding: 0; inset: auto calc(20px + env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) auto;
  width: min(380px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); border: 1px solid var(--line); border-radius: 16px;
  background: var(--bg); box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; }
.panel:not([open]) { display: none; }
.panel.left { inset: auto auto calc(20px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px)); }
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
.marking { display: grid; justify-items: start; gap: 6px; min-width: 0; }
.marks { display: grid; gap: 2px; width: 100%; margin: 0; padding: 0; list-style: none; }
.marks li { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; }
.marks .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.marks b { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.marks .x { width: 28px; height: 28px; }
.marks .x svg { width: 16px; height: 16px; }
.num { flex: none; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: #e5484d; color: #fff;
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums; box-shadow: 0 0 0 1.5px #fff; }
.marks .num { width: 20px; height: 20px; font-size: 11px; box-shadow: none; }

.layer { position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair; touch-action: pinch-zoom; direction: ltr;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.mk { position: fixed; pointer-events: none; border: 2px solid #e5484d; border-radius: 4px; background: rgba(229, 72, 77, .08); box-shadow: 0 0 0 1px rgba(255, 255, 255, .8); }
.mk.area { border-style: dashed; border-radius: 2px; }
.mk.draft { background: rgba(229, 72, 77, .14); }
.layer .num { position: fixed; cursor: pointer; }
.layer .num:hover { font-size: 0; }
.layer .num:hover::after { content: "×"; font-size: 17px; line-height: 1; }
.hl { position: fixed; pointer-events: none; border: 2px solid #e5484d; border-radius: 4px; background: rgba(229, 72, 77, .1);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .8); transition: left .06s, top .06s, width .06s, height .06s; }
.hl-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 6px; border-radius: 4px; background: #e5484d; color: #fff; font: 600 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.hl.low .hl-label { bottom: auto; top: 100%; margin: 4px 0 0; }
.pickbar { position: fixed; top: calc(12px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); cursor: default;
  display: flex; align-items: center; gap: 8px; width: max-content; max-width: calc(100vw - 24px); padding: 6px 6px 6px 16px; border-radius: 22px;
  background: var(--fab); color: var(--fab-fg); box-shadow: var(--shadow); font: 500 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  transition: opacity .15s; }
.pickbar span { flex: 1 1 auto; min-width: 0; }
.pickbar button { flex: none; height: 32px; border: 0; border-radius: 16px; padding: 0 14px; background: color-mix(in srgb, currentColor 16%, transparent); color: inherit; font-weight: 600; }
.pickbar button:disabled { opacity: .4; cursor: default; }
.pickbar .go { background: var(--fab-fg); color: var(--fab); }
.pickbar.faint { opacity: .2; }
@media (prefers-reduced-motion: reduce) { .hl, .pickbar { transition: none; } }
.err { color: var(--danger); font-size: 13px; }
.primary { width: 100%; height: 44px; border: 0; border-radius: 10px; background: var(--fg); color: var(--bg); font-size: 15px; font-weight: 600; }
.primary:hover:not(:disabled) { opacity: .9; }
.primary:disabled { opacity: .55; cursor: default; }
.done { display: grid; justify-items: center; gap: 10px; padding: 18px 0 8px; text-align: center; font-weight: 500; }
.done .mark { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--ok); color: #fff; }
.done svg { width: 24px; height: 24px; stroke-width: 2.4; }
.done .ref { margin-top: -6px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; user-select: text; -webkit-user-select: text; }
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

/** The visible part of the page without the widget, secrets covered; `k` is canvas px per viewport px. */
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
    return { canvas: out, k, w: W, h: H };
  } finally {
    for (const n of marked) n.removeAttribute(SHIFT);
  }
}

function drawMarks(base, marks) {
  const { k } = base;
  const c = h("canvas", { width: base.canvas.width, height: base.canvas.height });
  const g = c.getContext("2d");
  g.drawImage(base.canvas, 0, 0);
  const badges = placeBadges(marks.map(frameOf), base.w, base.h);
  marks.forEach((m, n) => {
    const f = frameOf(m);
    g.strokeStyle = RED;
    g.lineWidth = Math.max(2, Math.round(3 * k));
    g.setLineDash(m.type === "area" ? [8 * k, 5 * k] : []);
    g.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
    const b = badges[n];
    const r = (BADGE / 2) * k, cx = b.x * k + r, cy = b.y * k + r;
    g.setLineDash([]);
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = RED;
    g.fill();
    g.lineWidth = 1.5 * k;
    g.strokeStyle = "#fff";
    g.stroke();
    g.fillStyle = "#fff";
    g.font = `600 ${Math.round(12 * k)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(n + 1), cx, cy + 0.5 * k);
  });
  return c;
}

// ---------- the page's recent errors and failed requests ----------

/**
 * Records uncaught errors, unhandled rejections, console.error, resources that did not load and requests that failed
 * (fetch and XMLHttpRequest, status 400 and up or no answer), newest LOG_MAX kept, URLs cleaned like the page address.
 * Started only where the button shows (tester mode, staging hosts), so ordinary visitors of a live site run none of it.
 * Requests to Postbox itself and anything during a screenshot (the library fetches images and fonts) are left out.
 */
function recorder(postbox) {
  const list = [];
  let quiet = 0;
  const add = (e) => { if (!quiet) pushLog(list, { ...e, at: Date.now() }); };
  const abs = (u) => { try { return cleanUrl(new URL(String(u), location.href).href) ?? undefined; } catch { return undefined; } };
  const mine = (u) => { try { return new URL(String(u), location.href).origin === postbox; } catch { return false; } };
  addEventListener("error", (e) => {
    if (e instanceof ErrorEvent) add({ kind: "error", message: e.message || errText(e.error), source: e.filename ? `${abs(e.filename)}:${e.lineno}:${e.colno}` : undefined });
    else if (e.target instanceof Element) {
      const u = e.target.currentSrc || e.target.src || e.target.href;
      if (u && !mine(u)) add({ kind: "resource", message: `<${e.target.tagName.toLowerCase()}> did not load`, url: abs(u) });
    }
  }, true);
  addEventListener("unhandledrejection", (e) => add({ kind: "rejection", message: errText(e.reason) }));
  const consoleError = console.error;
  console.error = function (...a) { add({ kind: "console", message: a.map(errText).join(" ") }); return consoleError.apply(this, a); };
  const f = globalThis.fetch;
  if (typeof f === "function") {
    globalThis.fetch = function (input, init) {
      const url = input instanceof Request ? input.url : String(input);
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const p = f.call(globalThis, input, init);
      if (mine(url)) return p;
      // The page gets the same answer or the same rejection; a rejection it leaves unhandled still reports as one.
      return p.then(
        (r) => { if (!r.ok) add({ kind: "request", method, url: abs(r.url || url), status: r.status, message: r.statusText || "" }); return r; },
        (err) => { if (err?.name !== "AbortError") add({ kind: "request", method, url: abs(url), status: 0, message: errText(err) }); throw err; });
    };
  }
  const X = globalThis.XMLHttpRequest?.prototype;
  if (X) {
    const seen = new WeakMap();
    const open = X.open, send = X.send;
    // apply(arguments): passing an explicit undefined for `async` would make the request synchronous.
    X.open = function (method, url) { seen.set(this, { method: String(method).toUpperCase(), url: String(url) }); return open.apply(this, arguments); };
    X.send = function () {
      const m = seen.get(this);
      if (m && !mine(m.url)) {
        this.addEventListener("load", () => { if (this.status >= 400) add({ kind: "request", method: m.method, url: abs(this.responseURL || m.url), status: this.status, message: this.statusText || "" }); });
        this.addEventListener("error", () => add({ kind: "request", method: m.method, url: abs(m.url), status: 0, message: "network error" }));
        this.addEventListener("timeout", () => add({ kind: "request", method: m.method, url: abs(m.url), status: 0, message: "timeout" }));
      }
      return send.apply(this, arguments);
    };
  }
  return { list, quietly: async (task) => { quiet++; try { return await task(); } finally { quiet--; } } };
}

// ---------- widget ----------

export function start(script, queue = []) {
  const d = script.dataset;
  const key = d.key;
  const origin = new URL(script.src, location.href).origin;
  let t = STRINGS.en; // set by applyLang
  const fetchInit = { credentials: "omit", referrerPolicy: "no-referrer" }; // the cleaned URL is sent in meta, never the raw one in Referer

  const saved = store.get(KEY.tester);
  const tester = testerFlag(location.search, saved === "1" ? true : saved === "0" ? false : null);
  if (tester !== null) store.set(KEY.tester, tester ? "1" : "0");
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
  let dragged = false; // the click that ends a drag must not open the panel; a keyboard click (detail 0) always does
  const fab = h("button", {
    class: "fab", type: "button",
    onclick: (/** @type {MouseEvent} */ e) => { if (e.detail === 0 || !dragged) open(); },
  }, icon("bubble"));
  fab.hidden = !showButton(d.button || "auto", location.hostname, tester);
  const rec = fab.hidden ? null : recorder(origin);
  const dlg = h("dialog", { class: "panel", "aria-labelledby": "pb-title" });
  root.append(fab, dlg);
  // Picked on every open (sites switch language without a reload); the host's lang reaches screen readers.
  const applyLang = () => {
    const lang = pickLang(d.lang, document.documentElement.lang, navigator.languages || [navigator.language]);
    t = STRINGS[lang];
    host.lang = lang;
    fab.title = `${t.button} · ${t.move}`;
    fab.setAttribute("aria-label", t.button);
    dlg.setAttribute("data-drop", t.drop);
  };
  applyLang();
  // A press, focus move, key or scroll inside the widget never reaches the page: its open dialogs, sheets and popovers
  // would take it for one outside and close before the screenshot (Radix and most libraries listen on document in the
  // bubble phase), and its scroll lock would block scrolling in the panel. The widget's own listeners sit inside the
  // shadow root and run first; its document listeners only need the page's events.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "focusin", "focusout", "keydown", "keyup", "wheel", "touchmove"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  // Radix takes Esc in the capture phase, closes its top layer and cancels the key, so the panel stayed open: Esc from
  // inside the widget stops before any page listener. The dialog still closes (a default action), and the widget's only
  // keydown listener (Cmd or Ctrl+Enter in the note) never needs Esc. While marking, every key is the widget's.
  addEventListener("keydown", (e) => {
    if (marking && !host.isConnected) stopMarking(); // the page removed the widget: give it its keys back
    else if (marking) markKey(e);
    else if (e.key === "Escape" && e.composedPath().includes(host)) e.stopImmediatePropagation();
  }, true);
  // On <html>, not <body>: libraries that swap the body on navigation (Turbo, pjax) keep the widget.
  document.documentElement.append(host);

  // ---------- the floating button: docked to a side edge, dragged to any height, kept per site ----------
  let pos = initialFab(store.get(KEY.fab), d.position);
  const place = () => {
    for (const el of [fab, dlg]) el.classList.toggle("left", pos.side === "left"); // the panel opens on the button's side
    fab.style.setProperty("--pb-y", String(pos.y));
  };
  place();
  /** @type {{ id: number, x: number, y: number, moving: boolean } | null} */
  let drag = null;
  fab.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moving: false };
    dragged = false;
    fab.setPointerCapture(e.pointerId); // keeps the events coming over iframes and outside the window
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moving && !isDrag(dx, dy)) return;
    drag.moving = true;
    fab.classList.add("dragging");
    fab.style.setProperty("translate", `${dx}px ${dy}px`);
  });
  const drop = (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moving;
    drag = null;
    if (!moved) return;
    dragged = true;
    const centre = () => { const r = fab.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const from = centre();
    pos = snapFab(from.x, from.y, innerWidth, innerHeight);
    store.set(KEY.fab, JSON.stringify(pos));
    fab.classList.remove("dragging");
    fab.style.removeProperty("translate");
    place();
    // Glide from where it was let go to its place on the edge.
    const to = centre();
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fab.animate([{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: "0 0" }], { duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)" });
    }
  };
  fab.addEventListener("pointerup", drop);
  fab.addEventListener("pointercancel", drop);

  // On a phone the keyboard owns the bottom of the screen while the tester types into the page: the button steps aside, as in the kit.
  const coarse = matchMedia("(pointer: coarse)");
  const KEYBOARD = /^(text|search|email|url|tel|number|password)$/;
  const typing = () => {
    let a = document.activeElement;
    if (a === host) return false; // our own panel
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a instanceof HTMLElement && (a.isContentEditable || a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && KEYBOARD.test(a.type)));
  };
  const syncTyping = () => fab.classList.toggle("typing", coarse.matches && typing());
  document.addEventListener("focusin", syncTyping);
  document.addEventListener("focusout", () => setTimeout(syncTyping)); // activeElement settles after focusout

  const theme = () => host.setAttribute("data-postbox-theme", d.theme === "dark" || d.theme === "light" ? d.theme : isDark(pageBackground()) ? "dark" : "light");
  theme();

  // ---------- state ----------
  // shot: the JPEG as sent ("pending", "failed" or a Blob); base: the screenshot taken on open, which marks are drawn on.
  const S = { step: "form", kind: "bug", shot: null, shotTask: null, base: null, baseTask: null, include: true, images: [], marks: [], ctx: null, busy: false, run: 0 };
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
    if (marking) return; // Postbox.open() from the page while the tester marks
    if (dlg.open) { if (KINDS.includes(kind)) setKind(kind); ui.text?.focus(); return; }
    theme();
    applyLang();
    const run = ++S.run;
    S.ctx = context();
    const draft = readDraft();
    S.kind = KINDS.includes(kind) ? kind : KINDS.includes(draft.kind) ? draft.kind : "bug";
    S.include = true; S.images = []; S.busy = false; S.marks = [];
    S.at = { x: scrollX, y: scrollY }; // where the screenshot was taken; marking happens at the same place
    shoot(); // measured before the panel opens; the clone itself skips the widget
    loadLimits();
    S.step = store.get(KEY.consent) === "1" ? "form" : "consent";
    render(draft.text || "");
    fab.classList.add("away"); // under the scrim anyway; still focusable, so closing can give it focus back
    dlg.showModal();
  }

  /** Taken once on open; marks are drawn on it, so a toast gone by the time marking is done stays in the picture. */
  function shoot() {
    const run = S.run;
    S.base = null; S.shot = "pending";
    const task = () => capture(host);
    S.baseTask = (rec ? rec.quietly(task) : task()).then(
      (c) => { if (run === S.run) S.base = c; },
      (e) => console.warn("Postbox: screenshot failed.", e));
    redraw();
  }

  /** The JPEG as sent: the screenshot with the current marks. */
  function redraw() {
    const run = S.run;
    const marks = S.marks.map(({ type, rect }) => ({ type, rect }));
    const task = S.shotTask = S.baseTask
      .then(() => (S.base ? encode(drawMarks(S.base, marks), JPEG_QUALITY) : null))
      .catch((e) => { console.warn("Postbox: screenshot failed.", e); return null; })
      .then((b) => {
        if (run !== S.run || task !== S.shotTask) return;
        if (S.shotUrl) URL.revokeObjectURL(S.shotUrl);
        S.shot = b ?? "failed"; S.shotUrl = b ? URL.createObjectURL(b) : null;
        paintShot(); paintTiles();
      });
  }

  function close() { if (dlg.open) dlg.close(); }
  dlg.addEventListener("close", () => {
    if (S.marking) return; // closed only while the tester marks the page; everything stays
    fab.classList.remove("away");
    S.run++;
    clearTimeout(S.doneTimer);
    if (S.shotUrl) URL.revokeObjectURL(S.shotUrl);
    S.images.forEach((i) => URL.revokeObjectURL(i.url));
    S.shot = S.shotUrl = S.base = null; S.images = []; S.marks = [];
    dlg.replaceChildren();
    ui = {};
  });
  // A click on the scrim closes, like a sheet, unless marks or images would be lost.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg || S.marks.length || S.images.length) return;
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
      body = h("div", { class: "body" }, h("div", { class: "done", role: "status" }, h("span", { class: "mark" }, icon("check")), t.sent,
        S.sentId ? h("span", { class: "ref" }, t.sentRef.replace("{id}", String(S.sentId))) : null));
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
    ui.marks = h("div", { class: "marking" });
    ui.err = h("p", { class: "err", role: "alert", hidden: true });
    ui.send = h("button", { class: "primary", type: "submit" }, t.send);
    const c = S.ctx;
    const f = h("form", { class: "body", novalidate: true, onsubmit: (e) => { e.preventDefault(); send(); } },
      h("fieldset", { class: "kinds" }, h("legend", { class: "sr" }, t.kindLabel), KINDS.map((k, i) => h("label", {}, ui.kinds[i], h("span", {}, t.kinds[k])))),
      h("label", { class: "sr", htmlFor: "pb-text" }, t.textLabel), ui.text,
      ui.shot, ui.includeRow, ui.marks, ui.tiles, ui.file,
      h("p", { class: "ctx" }, `${t.context}: ${[c.screen, c.device, rec?.list.length ? t.logs.replace("{n}", String(rec.list.length)) : null].filter(Boolean).join(" · ")}`),
      ui.err, ui.send);
    paintShot();
    paintTiles();
    paintMarkList();
    return f;
  }

  // ---------- mark the problem ----------

  function paintMarkList(focusMark = false) {
    if (!ui.marks) return;
    const quote = (s) => ` "${s.length > 40 ? `${s.slice(0, 39)}…` : s}"`;
    const rows = S.marks.map((m, n) => h("li", {},
      h("span", { class: "num", "aria-hidden": "true" }, String(n + 1)),
      h("span", { class: "what" }, m.type === "area" ? `${t.area} ` : "", h("b", {}, m.name), m.type === "element" && m.info.text ? quote(m.info.text) : ""),
      h("button", {
        type: "button", class: "x", title: t.removeMark.replace("{n}", String(n + 1)), "aria-label": t.removeMark.replace("{n}", String(n + 1)),
        onclick: () => { S.marks.splice(n, 1); redraw(); paintMarkList(true); },
      }, icon("close"))));
    const more = h("button", { type: "button", class: "add", onclick: markPage }, icon("target"), S.marks.length ? t.markMore : t.mark);
    ui.marks.replaceChildren(...(rows.length ? [h("ol", { class: "marks" }, rows)] : []), more);
    if (focusMark) more.focus();
  }

  /** Selector, opening tag and visible text; never a field's value, nothing from a masked part. */
  function elementInfo(el, withText) {
    const masked = inMask(el);
    // A container's innerText includes its masked parts; textContent also has hidden and script text, so only SVG uses it.
    const hidden = !withText || masked || el.querySelector("[data-postbox-mask]") || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const text = hidden ? "" : (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    // A masked element's title, alt or aria-label can carry what the mask hides.
    const attrs = [...el.attributes].filter((a) => !masked || a.name === "id" || a.name === "class").map((a) => {
      if (a.name !== "href") return [a.name, a.value];
      try { return [a.name, cleanUrl(new URL(a.value, location.href).href) ?? ""]; } catch { return [a.name, ""]; }
    });
    return { selector: selectorOf(el), html: openingTag(el.tagName, attrs), ...(text ? { text } : {}) };
  }
  /** Inside a masked part, also across the shadow roots of the page's components. */
  function inMask(el) {
    for (let n = el; n; n = n.parentElement ?? n.getRootNode().host) if (n.matches(MASK)) return true;
    return false;
  }
  function selectorOf(el) {
    const scope = el.getRootNode();
    const sel = cssPath(el, (s) => { try { return scope.querySelectorAll(s).length; } catch { return 0; } });
    return scope instanceof ShadowRoot ? `${selectorOf(scope.host)} >>> ${sel}` : sel; // >>> enters a shadow root
  }

  /** The page element at a point, beneath the marking layer and inside open shadow roots. */
  function under(x, y) {
    let el = document.elementsFromPoint(x, y).find((n) => n !== host && n !== document.documentElement && n !== document.body) ?? null;
    for (let r = el?.shadowRoot; r; r = el.shadowRoot) {
      const inner = r.elementsFromPoint(x, y).find((n) => n !== el && r.contains(n));
      if (!inner) break;
      el = inner;
    }
    return el;
  }
  /** The smallest element around a dragged box, which names the area for the agent. */
  function around(box) {
    for (let el = under(box.x + box.w / 2, box.y + box.h / 2); el; el = el.parentElement ?? el.getRootNode().host ?? null) {
      if (holds(el.getBoundingClientRect(), box)) return el;
    }
    return document.body ?? document.documentElement;
  }

  // The layer takes every press and holds the page still: marks are drawn on the screenshot taken at this scroll position.
  const hl = h("div", { class: "hl", hidden: true }, h("span", { class: "hl-label" }));
  const draft = h("div", { class: "mk area draft", hidden: true });
  const frames = h("div");
  const help = h("span", { role: "status" });
  const undoBtn = h("button", { type: "button", onclick: () => undo() });
  const doneBtn = h("button", { type: "button", class: "go", onclick: () => finish() });
  const bar = h("div", { class: "pickbar" }, help, undoBtn, doneBtn);
  const layer = h("div", { class: "layer", hidden: true }, frames, hl, draft, bar);
  root.append(layer);
  /** @type {{ press: { id: number, x: number, y: number, box: { x: number, y: number, w: number, h: number } | null } | null } | null} */
  let marking = null;
  let helpTimer = 0;

  const setBox = (el, b) => { for (const [k, v] of [["left", b.x], ["top", b.y], ["width", b.w], ["height", b.h]]) el.style.setProperty(k, `${v}px`); };
  function setHelp(msg = "") {
    clearTimeout(helpTimer);
    help.textContent = msg || (coarse.matches ? t.markHelpTouch : t.markHelp);
    if (msg) helpTimer = setTimeout(setHelp, 2500);
  }
  function showHl(el) {
    hl.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox(hl, { x: r.left, y: r.top, w: r.width, h: r.height });
    hl.classList.toggle("low", r.top < 28); // the label goes under a box at the top edge
    hl.firstChild.textContent = shortName(el.tagName, el.id, [...el.classList]);
  }
  function paintFrames() {
    const W = document.documentElement.clientWidth || innerWidth, H = document.documentElement.clientHeight || innerHeight;
    const badges = placeBadges(S.marks.map(frameOf), W, H);
    frames.replaceChildren(...S.marks.flatMap((m, n) => {
      const f = frameOf(m), b = badges[n];
      const box = h("div", { class: m.type === "area" ? "mk area" : "mk" });
      setBox(box, f);
      const label = t.removeMark.replace("{n}", String(n + 1));
      const num = h("button", { type: "button", class: "num", title: label, "aria-label": label, tabIndex: -1, onclick: () => { S.marks.splice(n, 1); paintFrames(); } }, String(n + 1));
      setBox(num, { x: b.x, y: b.y, w: BADGE, h: BADGE });
      return [box, num];
    }));
    undoBtn.disabled = !S.marks.length;
  }
  function addMark(type, el, rect) {
    if (S.marks.length >= MAX_MARKS) { setHelp(t.markFull.replace("{n}", String(MAX_MARKS))); return; }
    S.marks.push({ type, el, rect, info: elementInfo(el, type === "element"), name: shortName(el.tagName, el.id, [...el.classList]) });
    paintFrames();
  }
  function toggleElement(el) {
    const at = S.marks.findIndex((m) => m.type === "element" && m.el === el);
    if (at >= 0) { S.marks.splice(at, 1); paintFrames(); return; }
    const r = el.getBoundingClientRect();
    addMark("element", el, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  function undo() {
    if (!S.marks.length) return;
    S.marks.pop();
    paintFrames();
    if (undoBtn.disabled) doneBtn.focus();
  }

  layer.addEventListener("pointerdown", (e) => {
    if (!marking || e.target !== layer || !e.isPrimary || e.button !== 0) return;
    marking.press = { id: e.pointerId, x: e.clientX, y: e.clientY, box: null };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", (e) => {
    if (!marking) return;
    const p = marking.press;
    if (!p) { showHl(e.target === layer && e.pointerType !== "touch" ? under(e.clientX, e.clientY) : null); return; }
    if (e.pointerId !== p.id || (!p.box && !isDrag(e.clientX - p.x, e.clientY - p.y))) return;
    p.box = boxBetween(p.x, p.y, e.clientX, e.clientY);
    hl.hidden = true;
    bar.classList.add("faint"); // a box may go under the bar
    setBox(draft, p.box);
    draft.hidden = false;
  });
  const release = (/** @type {PointerEvent} */ e) => {
    const p = marking?.press;
    if (!p || e.pointerId !== p.id) return;
    marking.press = null;
    draft.hidden = true;
    bar.classList.remove("faint");
    if (e.type === "pointercancel") return; // two fingers: the browser zooms
    if (p.box) addMark("area", around(p.box), p.box);
    else { const el = under(e.clientX, e.clientY); if (el) toggleElement(el); }
  };
  layer.addEventListener("pointerup", release);
  layer.addEventListener("pointercancel", release);
  layer.addEventListener("pointerleave", () => { if (!marking?.press) hl.hidden = true; });
  layer.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

  const SCROLL_KEYS = /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/;
  function markKey(e) {
    e.stopImmediatePropagation(); // the page's shortcuts wait until marking is done
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); finish(); }
    else if (((e.metaKey || e.ctrlKey) && k.toLowerCase() === "z") || k === "Backspace" || k === "Delete") { e.preventDefault(); undo(); }
    else if (k === "Tab") {
      e.preventDefault();
      const btns = [undoBtn, doneBtn].filter((b) => !b.disabled);
      btns[(btns.indexOf(root.activeElement) + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
    } else if (SCROLL_KEYS.test(k) || (k === " " && !(e.composedPath()[0] instanceof HTMLButtonElement))) e.preventDefault();
  }
  // Scrolling that still gets through (a scroll bar, a script) is undone.
  const hold = () => {
    if (marking && !host.isConnected) return stopMarking(); // the page removed the widget: give it its scroll back
    if (!marking || (scrollX === S.at.x && scrollY === S.at.y)) return;
    try { scrollTo({ left: S.at.x, top: S.at.y, behavior: "instant" }); } catch { scrollTo(S.at.x, S.at.y); }
  };

  function markPage() {
    if (S.busy || marking) return;
    saveDraft();
    S.marking = true; // the panel's close event keeps everything
    dlg.close();
    marking = { press: null };
    hold(); // the page may have scrolled under the panel's scrim
    addEventListener("scroll", hold, true);
    undoBtn.textContent = t.undo;
    doneBtn.textContent = t.markDone;
    setHelp();
    paintFrames();
    layer.hidden = false;
    doneBtn.focus();
  }
  function stopMarking() {
    marking = null;
    removeEventListener("scroll", hold, true);
    clearTimeout(helpTimer);
    layer.hidden = hl.hidden = draft.hidden = true;
    frames.replaceChildren();
    S.marking = false;
  }
  function finish() {
    if (!marking) return;
    stopMarking();
    dlg.showModal();
    redraw();
    paintMarkList(true);
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
      // Wait for the screenshot with the current marks (removing one meanwhile starts a newer one).
      for (let task; S.include && task !== S.shotTask;) { task = S.shotTask; await task; }
      if (run !== S.run) return;
      const shot = S.include && shotOk() ? S.shot : null;
      const blobs = [...(shot ? [shot] : []), ...S.images.map((i) => i.blob)];
      const bytes = blobs.reduce((n, b) => n + b.size, 0);
      if (blobs.length > l.max_attachments || bytes > l.max_total_bytes) { setError(t.errors.tooLarge); return; }
      const body = new FormData();
      const meta = buildMeta({ ...S.ctx, kind: S.kind, text }, l.max_text);
      if (rec?.list.length) meta.logs = logsForSend(rec.list, Date.now());
      if (S.marks.length) meta.marks = S.marks.map((m) => ({ type: m.type, ...m.info, rect: m.rect }));
      body.set("meta", JSON.stringify(meta));
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
        if (res.status === 403) console.warn(`Postbox: ${location.origin} is not in this mailbox's allowed origins; add it with postbox project origins.`);
        setError(t.errors[errorKey(res.status, err)]);
        return;
      }
      store.del(draftKey);
      // The letter number lets the tester mention it ("I sent #254"); a little longer on screen so it can be read.
      S.sentId = await res.json().then((j) => (Number.isInteger(j?.id) ? j.id : null), () => null);
      S.step = "done";
      render("");
      S.doneTimer = setTimeout(close, S.sentId ? 3500 : 1800);
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
