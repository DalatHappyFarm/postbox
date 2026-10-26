export type Kind = "bug" | "idea" | "other";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT = 4000;
export const SEND_TIMEOUT_MS = 20_000;
// Storage values keep the pre-rename "feedback-kit" prefix so installed apps keep their consent and device id.
export const CONSENT_KEY = "feedback-kit.consent.v1";
export const DEVICE_ID_KEY = "feedback-kit.device-id.v1";

export type Context = {
  screen?: string;
  app_version?: string | null;
  build?: string | null;
  platform: string;
  device?: string | null;
  os?: string | null;
  locale?: string;
  device_id: string;
};

export type Store = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

// ---- limits: the server is the source of truth (GET /api/limits); these are the spec defaults ----
export type Limits = { max_attachments: number; max_image_bytes: number; max_total_bytes: number; max_text: number };
export const DEFAULT_LIMITS: Limits = {
  max_attachments: 4, max_image_bytes: MAX_IMAGE_BYTES, max_total_bytes: 15 * 1024 * 1024, max_text: MAX_TEXT,
};
export const LIMITS_TIMEOUT_MS = 5000;

const limitsCache = new Map<string, Limits>();
const posInt = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

/** Fetched once per app session and endpoint, kept in memory. A failure returns defaults and is retried on the next open. */
export async function getLimits(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<Limits> {
  const base = endpoint.replace(/\/+$/, "");
  const have = limitsCache.get(base);
  if (have) return have;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/api/limits`, { signal: ctl.signal });
    if (!res.ok) return DEFAULT_LIMITS;
    const j = (await res.json()) as Partial<Limits>;
    const l: Limits = {
      max_attachments: posInt(j.max_attachments, DEFAULT_LIMITS.max_attachments),
      max_image_bytes: posInt(j.max_image_bytes, DEFAULT_LIMITS.max_image_bytes),
      max_total_bytes: posInt(j.max_total_bytes, DEFAULT_LIMITS.max_total_bytes),
      max_text: posInt(j.max_text, DEFAULT_LIMITS.max_text),
    };
    limitsCache.set(base, l);
    return l;
  } catch {
    return DEFAULT_LIMITS;
  } finally {
    clearTimeout(timer);
  }
}
export const resetLimitsCache = () => limitsCache.clear();

/** Photo slots left: max minus the screenshot when included, minus photos already picked. */
export const slotsLeft = (max: number, includeShot: boolean, photos: number) => Math.max(0, max - (includeShot ? 1 : 0) - photos);

// ---- images ----
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.7;
export const THUMB_EDGE = 320;
export const THUMB_QUALITY = 0.6;
export type Img = { uri: string; width: number; height: number; bytes: number };

/** Resize action capping the long edge; null when already small enough (never upscale). */
export function resizeFor(w: number, h: number, max = MAX_EDGE): { width: number } | { height: number } | null {
  if (!(w > 0 && h > 0) || Math.max(w, h) <= max) return null;
  return w >= h ? { width: max } : { height: max };
}

export type ImageDeps = {
  getSize(uri: string): Promise<{ width: number; height: number }>;
  manipulate(uri: string, resize: { width: number } | { height: number } | null, quality: number): Promise<{ uri: string; width: number; height: number }>;
  bytes(uri: string): number;
  remove(uri: string): void;
};

/** Resize + JPEG re-encode (drops EXIF, bakes orientation). The source file is deleted. Throws "too_large" over the cap. */
export async function processImage(d: ImageDeps, uri: string, maxBytes: number, size?: { width: number; height: number }): Promise<Img> {
  try {
    const { width, height } = size && size.width > 0 && size.height > 0 ? size : await d.getSize(uri);
    const out = await d.manipulate(uri, resizeFor(width, height), JPEG_QUALITY);
    const bytes = d.bytes(out.uri);
    if (bytes > maxBytes) { d.remove(out.uri); throw new Error("too_large"); }
    return { uri: out.uri, width: out.width, height: out.height, bytes };
  } finally {
    d.remove(uri);
  }
}

/** 320 px JPEG thumbnail of an already processed image. */
export async function makeThumb(d: ImageDeps, img: Img): Promise<Img> {
  const out = await d.manipulate(img.uri, resizeFor(img.width, img.height, THUMB_EDGE), THUMB_QUALITY);
  return { uri: out.uri, width: out.width, height: out.height, bytes: d.bytes(out.uri) };
}

// ---- picking ----
export type PickDeps = {
  library(limit: number): Promise<{ canceled: boolean; assets?: { uri: string; width: number; height: number }[] | null }>;
  camera(): Promise<{ canceled: boolean; assets?: { uri: string; width: number; height: number }[] | null }>;
  cameraPermission(): Promise<boolean>;
};
export type Pick = { kind: "ok"; assets: { uri: string; width: number; height: number }[] } | { kind: "cancelled" } | { kind: "denied" };

/** Camera permission is asked only here, only when the user chose Camera. */
export async function pick(d: PickDeps, source: "library" | "camera", remaining: number): Promise<Pick> {
  if (remaining <= 0) return { kind: "cancelled" };
  if (source === "camera" && !(await d.cameraPermission())) return { kind: "denied" };
  const r = source === "camera" ? await d.camera() : await d.library(remaining);
  if (r.canceled || !r.assets?.length) return { kind: "cancelled" };
  return { kind: "ok", assets: r.assets.slice(0, remaining) };
}

// ---- send ----
export type Meta = Context & { kind: Kind; text: string };
export type Part = [string, string | { uri: string; name: string; type: string }];

/** meta, screenshot, photo (repeated, in order), thumb: the spec field order. */
export function buildParts(a: { meta: Meta; maxText?: number; screenshot?: Img | null; photos: Img[]; thumb?: Img | null }): Part[] {
  const meta = { ...a.meta, text: a.meta.text.trim().slice(0, a.maxText ?? MAX_TEXT) };
  const file = (i: Img, name: string): Part[1] => ({ uri: i.uri, name, type: "image/jpeg" });
  const parts: Part[] = [["meta", JSON.stringify(meta)]];
  if (a.screenshot) parts.push(["screenshot", file(a.screenshot, "screenshot.jpg")]);
  a.photos.forEach((p, i) => parts.push(["photo", file(p, `photo-${i + 1}.jpg`)]));
  if (a.thumb) parts.push(["thumb", file(a.thumb, "thumb.jpg")]);
  return parts;
}

/** 20 s plus 10 s per MB, capped at 90 s. */
export const sendTimeout = (bytes: number) => Math.min(90_000, SEND_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * 10_000);

export type SendResult = { ok: true } | { ok: false; error: string };

/** The slice of XMLHttpRequest that send() uses (tests pass a fake). */
export type Xhr = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  timeout: number;
  status: number;
  onload: null | (() => void);
  onerror: null | (() => void);
  ontimeout: null | (() => void);
  onabort: null | (() => void);
};

/**
 * Multipart upload with XMLHttpRequest, not fetch: React Native's XHR reads {uri, name, type} file parts natively and sends
 * Content-Length, while the global fetch of Expo SDK 53+ (expo/fetch) cannot serialise such a part and rejects before any byte is sent.
 */
export function send(
  endpoint: string,
  projectKey: string,
  parts: Part[],
  timeoutMs = SEND_TIMEOUT_MS,
  newXhr: () => Xhr = () => new XMLHttpRequest() as unknown as Xhr,
  deviceId = "",
): Promise<SendResult> {
  return new Promise((resolve) => {
    let x: Xhr;
    try {
      const form = new FormData();
      // React Native's FormData reads {uri, name, type} file parts; the DOM typing does not know them.
      for (const [k, v] of parts) form.append(k, v as unknown as string);
      x = newXhr();
      x.open("POST", `${endpoint.replace(/\/+$/, "")}/api/submit`);
      // No content-type header: the multipart boundary is added by the request.
      x.setRequestHeader("x-project-key", projectKey);
      // X-Device-Id lets the server rate-limit per device before it reads the body.
      if (deviceId) x.setRequestHeader("x-device-id", deviceId);
      x.timeout = timeoutMs;
      x.onload = () => resolve(x.status >= 200 && x.status < 300 ? { ok: true } : { ok: false, error: `http ${x.status}` });
      x.onerror = () => resolve({ ok: false, error: "network" });
      x.ontimeout = () => resolve({ ok: false, error: "timeout" });
      x.onabort = () => resolve({ ok: false, error: "aborted" });
      x.send(form);
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
}

/** Deletes temp files the kit created; never throws. */
export function cleanup(uris: string[], remove: (uri: string) => void) {
  for (const u of uris) { try { remove(u); } catch { /* already gone */ } }
}

export const hasConsent = async (s: Store) => (await s.get(CONSENT_KEY)) === "1";
export const giveConsent = (s: Store) => s.set(CONSENT_KEY, "1");

/** Random per-install id, created once. Not a hardware id. */
export async function getDeviceId(s: Store, rand: () => number = Math.random): Promise<string> {
  const have = await s.get(DEVICE_ID_KEY);
  if (have) return have;
  const id = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");
  await s.set(DEVICE_ID_KEY, id);
  return id;
}

/** Shake = acceleration magnitude (in g, gravity included) above the threshold, at most once per cooldown. */
export const SHAKE_G = 2.2;
export const SHAKE_COOLDOWN_MS = 2000;
export function isShake(
  a: { x: number; y: number; z: number },
  now: number,
  lastShake: number,
  threshold = SHAKE_G,
  cooldown = SHAKE_COOLDOWN_MS,
): boolean {
  return Math.hypot(a.x, a.y, a.z) > threshold && now - lastShake >= cooldown;
}

// ---- floating button: position maths (points, window coordinates, y = top edge of the touch box) ----
export type Side = "left" | "right";
export type FabPos = { side: Side; y: number };
export type Insets = { top: number; right: number; bottom: number; left: number };
export type Size = { width: number; height: number };

export const FAB_TOUCH = 44; // touch target
export const FAB_VISIBLE = 40; // drawn circle, centred in the touch box
export const FAB_GAP = 6; // between the touch box and the safe-area edge
export const FAB_REST = 0.62; // default centre height, as a share of the window height
export const DRAG_SLOP = 10; // movement below this is a tap, above it a drag
export const FAB_KEY = "postbox.button-position.v1";

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const toInsets = (i?: Partial<Insets> | null): Insets => ({ top: num(i?.top), right: num(i?.right), bottom: num(i?.bottom), left: num(i?.left) });

/** Left edge of the touch box when docked to a side. */
export const fabX = (side: Side, win: Size, i: Insets) => (side === "left" ? i.left + FAB_GAP : win.width - i.right - FAB_GAP - FAB_TOUCH);

/** Keeps the touch box inside the safe area; a bad side or y falls back to right and the rest height. */
export function clampFab(pos: { side?: unknown; y?: unknown }, win: Size, i: Insets): FabPos {
  const lo = i.top + FAB_GAP;
  const hi = Math.max(lo, win.height - i.bottom - FAB_GAP - FAB_TOUCH);
  const y = num(pos.y, win.height * FAB_REST - FAB_TOUCH / 2);
  return { side: pos.side === "left" ? "left" : "right", y: Math.min(hi, Math.max(lo, Math.round(y))) };
}

/** Start position. buttonPosition wins; buttonBottom (deprecated) is the old distance from the bottom edge. */
export function initialFab(win: Size, i: Insets, o: { buttonPosition?: { side: Side; y: number }; buttonBottom?: number } = {}): FabPos {
  if (o.buttonPosition) return clampFab(o.buttonPosition, win, i);
  if (typeof o.buttonBottom === "number" && Number.isFinite(o.buttonBottom)) return clampFab({ side: "right", y: win.height - o.buttonBottom - FAB_TOUCH }, win, i);
  return clampFab({ side: "right" }, win, i);
}

/** Release point (left and top of the touch box) to the nearest docked side, y clamped. */
export function snapFab(x: number, y: number, win: Size, i: Insets): FabPos {
  const left = Math.abs(x - fabX("left", win, i)) < Math.abs(x - fabX("right", win, i));
  return clampFab({ side: left ? "left" : "right", y }, win, i);
}

/** Tap or drag: true once the finger moved more than the slop. */
export const isDrag = (dx: number, dy: number, slop = DRAG_SLOP) => Math.hypot(dx, dy) > slop;

/** Stored value back to a position; anything unexpected is null. */
export function parseFab(raw: string | null | undefined): FabPos | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { side?: unknown; y?: unknown } | null;
    if (!v || typeof v !== "object" || (v.side !== "left" && v.side !== "right") || typeof v.y !== "number" || !Number.isFinite(v.y)) return null;
    return { side: v.side, y: v.y };
  } catch {
    return null;
  }
}
export const serializeFab = (p: FabPos) => JSON.stringify({ side: p.side, y: p.y });
