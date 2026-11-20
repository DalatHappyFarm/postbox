// What the web widget sends about the page besides the note: recent errors and failed requests (`logs`) and the
// parts of the page the tester marked (`marks`). Both are optional extras, so a bad value is dropped, never a reason to
// refuse the letter; every string is cut to a fixed length.

export const LOG_KINDS = ["error", "rejection", "console", "resource", "request"] as const;
export type Log = {
  kind: (typeof LOG_KINDS)[number]; message: string; source?: string; method?: string; url?: string; status?: number; seconds_before: number;
};
/** A part of the page the tester marked: an element they clicked, or an area they dragged (its selector is the smallest element around it). */
export type Mark = { type: "element" | "area"; selector: string; html?: string; text?: string; rect?: { x: number; y: number; w: number; h: number } };

const MAX_LOGS = 20;
export const MAX_MARKS = 9;

// Postgres refuses NUL and half of a surrogate pair (a cut through an emoji) in json and text, so a letter holding one was
// lost with a 500; a line break in a one-line value could start a forged heading in a brief.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g; // a note keeps its tabs and line breaks
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s: string) => s.replace(LONE, "\uFFFD");
/** A one-line value as stored: controls and line breaks become spaces, half characters become U+FFFD. */
export const oneLine = (s: string) => wellFormed(s.replace(CONTROL, " "));
/** The tester's note as stored: line breaks normalised, other controls dropped, half characters become U+FFFD. */
export const noteText = (s: string) => wellFormed(s.replace(/\r\n?/g, "\n").replace(NOTE_CONTROL, ""));
/** Trimmed one-line text cut to `max` (the cut itself can split a pair, so it is made whole again); at most 3 bytes per character. */
const cut = (v: unknown, max: number) => {
  const s = typeof v === "string" ? wellFormed(oneLine(v).trim().slice(0, max)) : "";
  return s || undefined;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Valid entries only, newest last, at most 20; null when nothing valid is left. */
export function cleanLogs(v: unknown): Log[] | null {
  if (!Array.isArray(v)) return null;
  const out: Log[] = [];
  for (const x of v.slice(-MAX_LOGS)) {
    if (!isObj(x) || !LOG_KINDS.includes(x.kind as Log["kind"])) continue;
    const message = cut(x.message, 300) ?? (x.kind === "request" ? "" : undefined);
    const seconds = Number(x.seconds_before);
    if (message === undefined || !Number.isFinite(seconds) || seconds < 0) continue;
    const e: Log = { kind: x.kind as Log["kind"], message, seconds_before: Math.min(86_400, Math.round(seconds)) };
    const source = cut(x.source, 300), url = cut(x.url, 500), method = cut(x.method, 10);
    if (source) e.source = source;
    if (url) e.url = url;
    if (method && /^[A-Za-z]+$/.test(method)) e.method = method.toUpperCase();
    if (Number.isInteger(x.status) && (x.status as number) >= 0 && (x.status as number) <= 999) e.status = x.status as number;
    out.push(e);
  }
  return out.length ? out : null;
}

const coord = (v: unknown, min: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100_000, Math.max(min, Math.round(v))) : null);

/**
 * Valid marks only, in order, at most 9 (null when none); a selector is required, the tag, text and box are optional.
 * `legacy` is the single `element` that widgets from before marks send (still cached in open tabs).
 */
export function cleanMarks(v: unknown, legacy?: unknown): Mark[] | null {
  const list = Array.isArray(v) ? v : isObj(legacy) ? [{ ...legacy, type: "element" }] : [];
  const out: Mark[] = [];
  for (const x of list.slice(0, MAX_MARKS)) {
    if (!isObj(x)) continue;
    const selector = cut(x.selector, 500);
    if (!selector) continue;
    const m: Mark = { type: x.type === "area" ? "area" : "element", selector };
    const html = cut(x.html, 500), t = cut(x.text, 200);
    if (html) m.html = html;
    if (t) m.text = t;
    const r = isObj(x.rect) ? x.rect : {};
    const rect = { x: coord(r.x, -100_000), y: coord(r.y, -100_000), w: coord(r.w, 0), h: coord(r.h, 0) };
    if (Object.values(rect).every((n) => n !== null)) m.rect = rect as Mark["rect"];
    out.push(m);
  }
  return out.length ? out : null;
}
