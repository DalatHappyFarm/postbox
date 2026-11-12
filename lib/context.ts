// What the web widget sends about the page besides the note: recent errors and failed requests (`logs`) and the
// element the tester pointed at (`element`). Both are optional extras, so a bad value is dropped, never a reason to
// refuse the letter; every string is cut to a fixed length.

export const LOG_KINDS = ["error", "rejection", "console", "resource", "request"] as const;
export type Log = {
  kind: (typeof LOG_KINDS)[number]; message: string; source?: string; method?: string; url?: string; status?: number; seconds_before: number;
};
export type PageElement = { selector: string; html?: string; text?: string };

const MAX_LOGS = 20;
const cut = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
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

/** The pointed element, or null; a selector is required, the opening tag and the visible text are optional. */
export function cleanElement(v: unknown): PageElement | null {
  if (!isObj(v)) return null;
  const selector = cut(v.selector, 500);
  if (!selector) return null;
  const e: PageElement = { selector };
  const html = cut(v.html, 500), text = cut(v.text, 200);
  if (html) e.html = html;
  if (text) e.text = text;
  return e;
}
