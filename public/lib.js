// Pure helpers for the dashboard; no DOM, unit tested in test/dashboard.test.ts.

export const STATUSES = ["new", "doing", "done", "wont_fix"];
// UI words from docs/postbox.md section 2; the API keeps the technical status names.
export const STATUS_LABEL = { new: "Unread", doing: "In progress", done: "Done", wont_fix: "Won't fix" };
export const KINDS = ["bug", "idea", "other"];
export const KIND_LABEL = { bug: "Bug", idea: "Idea", other: "Other" };

/** Quick filter tabs; `status` is the API filter value ("active" = Unread + In progress, two streams). */
export const TABS = [
  { key: "open", label: "Open", status: "active" },
  { key: "unread", label: "Unread", status: "new" },
  { key: "doing", label: "In progress", status: "doing" },
  { key: "done", label: "Done", status: "done" },
  { key: "wont_fix", label: "Won't fix", status: "wont_fix" },
  { key: "all", label: "All", status: "" },
];
export const tabStatus = (key) => (TABS.find((t) => t.key === key) || TABS[0]).status;

export const TOKEN_KEY = "postbox_admin_token";
export const OLD_TOKEN_KEY = "fh_admin_token";

/** Tolerates what people paste: surrounding spaces and quotes, or a whole `NAME="token"` line from an env file. */
export function cleanToken(raw) {
  let t = String(raw ?? "").trim();
  const eq = t.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
  if (eq) t = eq[1].trim();
  return t.replace(/^(["'`])(.*)\1$/, "$2").trim();
}

/** Token from storage; a token under the old key is moved to the new key once. Never throws. */
export function migrateToken(storage) {
  try {
    const cur = storage.getItem(TOKEN_KEY);
    if (cur) return cur;
    const old = storage.getItem(OLD_TOKEN_KEY);
    if (!old) return "";
    storage.setItem(TOKEN_KEY, old);
    storage.removeItem(OLD_TOKEN_KEY);
    return old;
  } catch { return ""; }
}

/** First line of a letter, the "subject" in the list. */
export const firstLine = (text) => String(text ?? "").split("\n")[0].trim();

/** Client-side search over loaded letters: every word must appear in text, screen, mailbox, note or kind. */
export function matchesSearch(i, q) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [i.text, i.screen, i.project, i.note, i.kind, i.platform].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Unread letters per mailbox slug, plus the total. */
export function unreadCounts(items) {
  const by = {};
  for (const i of items) if (i.status === "new") by[i.project] = (by[i.project] || 0) + 1;
  return { by, total: items.filter((i) => i.status === "new").length };
}

/** One key press to an action name; `pendingG` is the "g then i" chord state. Pure so it can be tested. */
export function shortcutAction(key, pendingG = false) {
  if (pendingG) return { action: key === "i" ? "allMail" : null, pendingG: false };
  if (key === "g") return { action: null, pendingG: true };
  const simple = { j: "next", k: "prev", Enter: "open", e: "status:done", u: "status:new", "/": "search", "?": "help" };
  if (simple[key]) return { action: simple[key], pendingG: false };
  if (/^[1-4]$/.test(key)) return { action: `status:${STATUSES[Number(key) - 1]}`, pendingG: false };
  return { action: null, pendingG: false };
}

/** Lightbox position after an arrow key; stays inside the strip. */
export const stepIndex = (n, count, dir) => Math.min(count - 1, Math.max(0, n + dir));

/** Filter value "active" means new + doing, which the API only takes one at a time. */
export function statusStreams(status) {
  return status === "active" ? ["new", "doing"] : status ? [status] : [""];
}

/** Query string for GET /api/feedback; empty filters are left out. */
export function listQuery({ project = "", status = "", kind = "", cursor = "", limit = 50 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (project) q.set("project", project);
  if (status) q.set("status", status);
  if (kind) q.set("kind", kind);
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

/** "3 h ago" style age. */
export function relativeTime(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo} mo ago` : `${Math.floor(d / 365)} y ago`;
}

/** Same markdown as `postbox show` (packages/cli/src/index.ts), plus the photos line for the agent. */
export function brief(i) {
  const row = (k, v) => (v == null || v === "" ? [] : [`- ${k}: ${v}`]);
  return [
    `# Feedback #${i.id}`,
    "",
    ...row("project", i.project), ...row("kind", i.kind), ...row("status", i.status), ...row("screen", i.screen),
    ...row("build", [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ")),
    ...row("platform", i.platform), ...row("device", i.device), ...row("os", i.os), ...row("url", i.url),
    ...row("created", i.created_at),
    ...(i.attachment_count ? [`Photos: ${i.attachment_count}, run postbox show ${i.id} to download them`] : []),
    "",
    "## Text",
    "",
    i.text,
    ...(i.note ? ["", "## Note", "", i.note] : []),
  ].join("\n");
}

/** Merge item lists from several streams, newest (highest id) first, no duplicates. */
export function mergeItems(...lists) {
  const byId = new Map();
  for (const l of lists) for (const i of l) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** Image for a list row: the small thumb when there is one, else the first image; null for text-only feedback. */
export function thumbPath(i) {
  if (!i.attachment_count) return null;
  return i.has_thumb ? `/api/feedback/${i.id}/thumb` : `/api/feedback/${i.id}/attachments/0`;
}

/** "+N" badge for the images beyond the one shown; empty for zero or one image. */
export const moreBadge = (i) => (i.attachment_count > 1 ? `+${i.attachment_count - 1}` : "");
