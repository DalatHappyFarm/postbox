// Pure helpers for the web widget (no DOM), tested in test/widget.test.ts.

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.7;
export const THUMB_EDGE = 320;
export const THUMB_QUALITY = 0.6;
export const DEFAULT_LIMITS = { max_attachments: 4, max_image_bytes: 5 * 1024 * 1024, max_total_bytes: 15 * 1024 * 1024, max_text: 4000 };
const FIELD_MAX = { screen: 200, app_version: 200, build: 200, device: 200, os: 200, locale: 200, url: 2000, device_id: 200 };

/** Long edge capped at max, never upscaled. */
export function resizeDims(w, h, max = MAX_EDGE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Image slots left: max minus the screenshot when included, minus images already added. */
export const slotsLeft = (max, includeShot, images) => Math.max(0, max - (includeShot ? 1 : 0) - images);

/** 20 s plus 10 s per MB, capped at 90 s (same as the React Native kit). */
export const sendTimeout = (bytes) => Math.min(90_000, 20_000 + Math.ceil(bytes / (1024 * 1024)) * 10_000);

const posInt = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
/** Server limits (GET /api/limits) over the defaults; anything missing or invalid keeps the default. */
export function readLimits(j) {
  const o = j && typeof j === "object" ? j : {};
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, d]) => [k, posInt(o[k], d)]));
}

// ---- when the floating button shows ----

const PRIVATE_V4 = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/;
/** Development, preview and staging hosts, where testers are expected. */
export function isStagingHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || PRIVATE_V4.test(h) || /\.(localhost|test|local)$/.test(h)) return true;
  if (/\.(pages\.dev|vercel\.app|netlify\.app|workers\.dev)$/.test(h)) return true;
  return /^(staging|stage|dev|preview|test|qa)[.-]/.test(h);
}

/**
 * `?feedback` (or `=1`) turns tester mode on for this browser, `?feedback=0|off|false|no` turns it off;
 * otherwise the stored choice stays (null: never chosen).
 * @param {string | undefined} search
 * @param {boolean | null | undefined} stored
 * @returns {boolean | null}
 */
export function testerFlag(search, stored) {
  const v = new URLSearchParams(search || "").get("feedback");
  if (v === null) return stored ?? null;
  return !["0", "off", "false", "no"].includes(v.toLowerCase());
}

/**
 * data-button: "always", "never" or "auto" (default): on staging hosts and in tester mode;
 * a tester who switched it off (`?feedback=off`) does not see it, on staging hosts either.
 * @param {string | undefined} mode
 * @param {string} hostname
 * @param {boolean | null | undefined} tester
 */
export function showButton(mode, hostname, tester) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return tester ?? isStagingHost(hostname);
}

// ---- where the floating button sits: docked to a side edge at any height, moved by dragging (as in the React Native kit) ----

export const FAB_REST = 0.62; // default height of the button's centre, as a share of the viewport height
export const DRAG_SLOP = 10; // pointer movement below this (px) is a click, above it a drag

/** Click or drag: true once the pointer moved more than the slop. */
export const isDrag = (dx, dy, slop = DRAG_SLOP) => Math.hypot(dx, dy) > slop;

/** Where the button's centre was let go, to the nearest side edge and the centre height as a share of the viewport. */
export function snapFab(cx, cy, width, height) {
  const y = height > 0 ? Math.min(1, Math.max(0, cy / height)) : FAB_REST;
  return { side: cx < width / 2 ? "left" : "right", y: Math.round(y * 1000) / 1000 };
}

/**
 * The position the tester left the button at (stored JSON), else data-position at the default height.
 * @param {string | null} stored
 * @param {string | undefined} position
 * @returns {{ side: "left" | "right", y: number }}
 */
export function initialFab(stored, position) {
  try {
    const v = JSON.parse(stored ?? "null");
    if ((v?.side === "left" || v?.side === "right") && Number.isFinite(v.y) && v.y >= 0 && v.y <= 1) return { side: v.side, y: v.y };
  } catch {
    // not JSON: fall through to the default
  }
  return { side: position === "left" ? "left" : "right", y: FAB_REST };
}

// ---- what is sent along ----

const SENSITIVE = /(^|[_.-])(token|code|key|apikey|secret|session|sid|auth|password|pass|pwd|otp|signature|sig|email|jwt|ticket)([_.-]|$)/i;
const scrub = (params) => {
  for (const k of [...new Set(params.keys())]) {
    if (k.toLowerCase() === "feedback") params.delete(k);
    else if (SENSITIVE.test(k.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))) params.set(k, "redacted"); // accessToken counts as access_token
  }
};
const HASH_ROUTE = /^#!?\//;

/** The page address without credentials, secrets in the query or the fragment (kept only for #/ routes, scrubbed too). */
export function cleanUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  u.username = ""; u.password = "";
  scrub(u.searchParams);
  let hash = "";
  const m = HASH_ROUTE.exec(u.hash);
  if (m) {
    const r = new URL(u.hash.slice(m[0].length - 1), "http://x");
    scrub(r.searchParams);
    hash = m[0].slice(0, -1) + r.pathname + r.search;
  }
  const search = u.searchParams.toString();
  return (u.origin + u.pathname + (search ? "?" + search : "") + hash).slice(0, FIELD_MAX.url);
}

const ID = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)[0-9a-f]{16,}$/i, // object ids, hashes
  /^[0-9A-HJKMNP-TV-Z]{26}$/, // ULID
  /^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9]{20,}$/, // Firestore-style ids (no dashes, so slugs stay)
];
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Screen name from the address: the path (plus a #/ route) with ids folded to `:id`, so letters group by page. */
export function normalizeScreen(pathname, hash = "") {
  const m = HASH_ROUTE.exec(hash);
  const route = m ? hash.slice(m[0].length - 1).split(/[?#]/)[0] : "";
  const path = route ? String(pathname || "/").replace(/\/+$/, "") + route : String(pathname || "/");
  const segs = path.split("/").filter(Boolean).map((s) => (ID.some((r) => r.test(s)) ? ":id" : decode(s)));
  return ("/" + segs.join("/")).slice(0, FIELD_MAX.screen);
}

const BROWSERS = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/CocCoc\/(\d+)/, "Coc Coc"],
  [/(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
  [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/Version\/(\d+(?:\.\d+)?).*Safari/, "Safari"],
];
const IN_APP = [[/Zalo/i, "Zalo"], [/FBAN|FBAV|FB_IAB/, "Facebook"], [/Instagram/, "Instagram"], [/Line\//, "LINE"]];

/**
 * Browser and viewport for `device`, the OS for `os`, both from the user agent (in-app browsers are named, they are a common source of bugs).
 * @param {string} ua
 * @param {{ w?: number, h?: number, dpr?: number, touch?: number }} [view]
 * @returns {{ device: string, os: string | null }}
 */
export function describe(ua, { w, h, dpr = 1, touch = 0 } = {}) {
  const s = String(ua || "");
  const b = BROWSERS.find(([r]) => r.test(s));
  const app = IN_APP.find(([r]) => r.test(s));
  let browser = b ? `${b[1]} ${b[0].exec(s)[1]}` : "Browser";
  if (app) browser += ` (${app[1]} in-app)`;
  const ratio = Math.round(dpr * 100) / 100;
  const view = w && h ? ` · ${Math.round(w)}x${Math.round(h)}${ratio !== 1 ? ` @${ratio}x` : ""}` : "";
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(s);
  const android = /Android (\d+(?:\.\d+)?)/.exec(s);
  // ponytail: Windows and macOS versions are frozen in the user agent; read navigator.userAgentData high-entropy values if they ever matter.
  const os = ios ? `iOS ${ios[1]}.${ios[2]}`
    : android ? `Android ${android[1]}`
    : /Windows NT/.test(s) ? "Windows"
    : /CrOS/.test(s) ? "ChromeOS"
    : /Mac OS X/.test(s) ? (touch > 1 ? "iPadOS" : "macOS")
    : /Linux/.test(s) ? "Linux"
    : null;
  return { device: (browser + view).slice(0, FIELD_MAX.device), os };
}

const clip = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * The `meta` field of a submit; empty values are left out, every value fits the server's limits.
 * @param {Record<string, unknown>} f
 * @returns {Record<string, string>}
 */
export function buildMeta(f, maxText = DEFAULT_LIMITS.max_text) {
  const meta = { kind: f.kind, text: String(f.text || "").trim().slice(0, maxText), platform: "web" };
  for (const k of Object.keys(FIELD_MAX)) { const v = clip(f[k], FIELD_MAX[k]); if (v !== undefined) meta[k] = v; }
  return meta;
}

/** Which message to show for a failed send: status 0 is a network failure or timeout. */
export function errorKey(status, error) {
  if (status === 0) return "offline";
  if (status === 429) return "rate";
  if (status === 401) return "setup";
  if (status === 413) return error === "text too long" ? "textLong" : "tooLarge";
  if (status === 415) return "badImage";
  if (status === 400 && error === "text is required") return "empty";
  return "server";
}

// ---- words ----

export const STRINGS = {
  en: {
    button: "Send feedback", move: "drag to move", title: "Send feedback", close: "Close",
    consent: "Your note, a screenshot of this page and any images you add go to the team that builds this site. Images are deleted after 90 days.",
    consentOk: "OK, continue",
    kinds: { bug: "Bug", idea: "Idea", other: "Other" }, kindLabel: "Kind",
    placeholder: "What happened, or what would help?", textLabel: "Your note",
    include: "Include screenshot", capturing: "Taking a screenshot…",
    shotFailed: "Could not capture this page. Paste or add a screenshot instead.",
    addImage: "Add image", paste: "or paste", remove: "Remove image", screenshot: "Screenshot of this page", image: "Image",
    drop: "Drop images to add them", full: "No more images can be added.",
    context: "Sent along",
    send: "Send", sending: "Sending…", sent: "Sent. Thank you!",
    errors: {
      empty: "Write a few words first.", offline: "Could not reach the server. Check the connection and try again.",
      rate: "You have sent a lot in the last hour. Try again later.", setup: "Feedback is not set up correctly on this site.",
      tooLarge: "The images are too large. Remove one and try again.", textLong: "The note is too long.",
      badImage: "This image cannot be used. Add a JPEG or PNG.", server: "Something went wrong on the server. Try again.",
    },
  },
  vi: {
    button: "Gửi góp ý", move: "kéo để di chuyển", title: "Gửi góp ý", close: "Đóng",
    consent: "Ghi chú, ảnh chụp trang này và ảnh bạn thêm sẽ được gửi cho đội làm website. Ảnh được xoá sau 90 ngày.",
    consentOk: "Đồng ý, tiếp tục",
    kinds: { bug: "Lỗi", idea: "Ý tưởng", other: "Khác" }, kindLabel: "Loại",
    placeholder: "Có gì chưa ổn, hoặc điều gì sẽ giúp bạn?", textLabel: "Ghi chú của bạn",
    include: "Kèm ảnh màn hình", capturing: "Đang chụp màn hình…",
    shotFailed: "Không chụp được trang này. Hãy dán hoặc thêm ảnh chụp.",
    addImage: "Thêm ảnh", paste: "hoặc dán", remove: "Xoá ảnh", screenshot: "Ảnh chụp trang này", image: "Ảnh",
    drop: "Thả ảnh vào đây để thêm", full: "Đã đủ số ảnh tối đa.",
    context: "Gửi kèm",
    send: "Gửi", sending: "Đang gửi…", sent: "Đã gửi. Cảm ơn bạn!",
    errors: {
      empty: "Hãy viết vài chữ trước đã.", offline: "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.",
      rate: "Bạn đã gửi khá nhiều trong một giờ qua. Hãy thử lại sau.", setup: "Góp ý chưa được cài đúng trên website này.",
      tooLarge: "Ảnh quá lớn. Bỏ bớt một ảnh rồi thử lại.", textLong: "Ghi chú quá dài.",
      badImage: "Không dùng được ảnh này. Hãy thêm ảnh JPEG hoặc PNG.", server: "Máy chủ gặp lỗi. Hãy thử lại.",
    },
  },
};

/** data-lang, then the page's <html lang>, then the browser; Vietnamese or English. */
export function pickLang(dataLang, htmlLang, navLangs = []) {
  const l = [dataLang, htmlLang, ...navLangs].find((x) => typeof x === "string" && x.trim());
  return l && l.trim().toLowerCase().startsWith("vi") ? "vi" : "en";
}
