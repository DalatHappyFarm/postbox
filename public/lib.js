// Pure helpers for the dashboard; no DOM, unit tested in test/dashboard.test.ts.

export const STATUSES = ["new", "ready", "doing", "done", "wont_fix", "duplicate"];
// UI words from docs/postbox.md section 2; the API keeps the technical status names.
export const STATUS_LABEL = { new: "Unread", ready: "Ready for agent", doing: "In progress", done: "Done", wont_fix: "Won't fix", duplicate: "Duplicate" };
export const KINDS = ["bug", "idea", "other"];
export const KIND_LABEL = { bug: "Bug", idea: "Idea", other: "Other" };
export const PLATFORMS = ["ios", "android", "web", "other"];

/** Status facet rows. `status` is the API filter (comma list); "open" is everything not decided away. */
export const STATUS_VIEWS = [
  { key: "open", label: "Open", status: "new,ready,doing" },
  { key: "new", label: STATUS_LABEL.new, status: "new" },
  { key: "ready", label: STATUS_LABEL.ready, status: "ready" },
  { key: "doing", label: STATUS_LABEL.doing, status: "doing" },
  { key: "done", label: STATUS_LABEL.done, status: "done" },
  { key: "wont_fix", label: STATUS_LABEL.wont_fix, status: "wont_fix" },
  { key: "duplicate", label: STATUS_LABEL.duplicate, status: "duplicate" },
  { key: "all", label: "All", status: "" },
];
export const viewStatus = (key) => (STATUS_VIEWS.find((v) => v.key === key) || STATUS_VIEWS[0]).status;
/** Letters a view shows, from the API's status counts (the Open row is a sum). */
export const viewCount = (key, byStatus = {}) =>
  viewStatus(key) ? viewStatus(key).split(",").reduce((n, s) => n + (byStatus[s] || 0), 0) : Object.values(byStatus).reduce((n, v) => n + v, 0);
/** Does a letter with this status belong in the view? */
export const inView = (key, status) => !viewStatus(key) || viewStatus(key).split(",").includes(status);

/** Priority 0 urgent .. 3 low; null means not set. Keys 1-4 map to 0-3. */
export const PRIORITIES = [{ n: 0, label: "Urgent" }, { n: 1, label: "High" }, { n: 2, label: "Normal" }, { n: 3, label: "Low" }];
export const priorityLabel = (n) => PRIORITIES.find((p) => p.n === n)?.label || "";
export const SORTS = [{ key: "new", label: "Newest first" }, { key: "old", label: "Oldest first" }, { key: "priority", label: "Priority, then oldest" }];

export const MAX_LABELS = 8;

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


/** Lower case, dashes for separators, only a-z 0-9 and "-", at most 32 characters. */
export function normalizeLabel(raw) {
  return String(raw ?? "").toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}
/** "" when the label can be added to a letter that already has `existing`; else the reason. */
export function labelError(label, existing = []) {
  if (!label) return "Use letters, digits and dashes.";
  if (existing.includes(label)) return "Already on this letter.";
  if (existing.length >= MAX_LABELS) return `At most ${MAX_LABELS} labels per letter.`;
  return "";
}

/** The status facet row and everything else the list needs, as one object; "" and false are defaults and stay out of the URL. */
export const DEFAULT_STATE = { project: "", status: "open", kind: "", priority: "", label: "", source: "", screen: "", build: "", q: "", sort: "new", group: false, letter: 0, triage: false };
const HASH_KEYS = ["project", "status", "kind", "priority", "label", "source", "screen", "build", "q", "sort"];

export function encodeHash(s) {
  const p = new URLSearchParams();
  for (const k of HASH_KEYS) if (s[k] !== undefined && s[k] !== DEFAULT_STATE[k]) p.set(k, String(s[k]));
  if (s.group) p.set("group", "1");
  if (s.triage) p.set("triage", "1");
  if (s.letter) p.set("id", String(s.letter));
  const qs = p.toString();
  return qs ? `#/?${qs}` : "#/";
}

export function decodeHash(hash) {
  const s = { ...DEFAULT_STATE };
  const legacy = /^#\/feedback\/(\d+)$/.exec(hash || "");
  if (legacy) return { ...s, letter: Number(legacy[1]) };
  const p = new URLSearchParams(String(hash || "").replace(/^#\/?\??/, ""));
  for (const k of HASH_KEYS) if (p.has(k)) s[k] = p.get(k);
  if (!STATUS_VIEWS.some((v) => v.key === s.status)) s.status = DEFAULT_STATE.status;
  if (!SORTS.some((o) => o.key === s.sort)) s.sort = DEFAULT_STATE.sort;
  if (!/^([0-3]|none)?$/.test(s.priority)) s.priority = "";
  if (!KINDS.includes(s.kind)) s.kind = "";
  if (s.source && !["app", "web"].includes(s.source)) s.source = "";
  s.group = p.get("group") === "1";
  s.triage = p.get("triage") === "1";
  s.letter = Number(p.get("id")) > 0 ? Number(p.get("id")) : 0;
  return s;
}

/** Query string for GET /api/feedback (docs/triage-spec.md section 3); empty filters are left out, `status` is the API value. */
export function listQuery({ project = "", status = "", kind = "", q = "", screen = "", build = "", priority = "", label = "", source = "", sort = "new", cursor = "", limit = 50 } = {}) {
  const p = new URLSearchParams({ limit: String(limit) });
  const add = (k, v) => v !== "" && v != null && p.set(k, v);
  add("project", project); add("status", status); add("kind", kind); add("q", q.trim());
  add("screen", screen); add("build", build); add("priority", priority); add("label", label); add("source", source);
  if (sort && sort !== "new") p.set("sort", sort);
  add("cursor", cursor);
  return p.toString();
}
/** The list query for the app state, without paging. */
export const stateQuery = (s, extra = {}) => listQuery({ ...s, status: viewStatus(s.status), ...extra });

/** One key press to an action name; `pendingG` is the "g then i" chord state. Pure so it can be tested. */
export function shortcutAction(key, pendingG = false) {
  if (pendingG) return { action: key === "i" ? "allMail" : null, pendingG: false };
  if (key === "g") return { action: null, pendingG: true };
  const simple = { j: "next", k: "prev", Enter: "open", r: "ready", w: "wont", d: "dup", l: "label", s: "skip", u: "unread", e: "done", z: "undo",
    x: "select", t: "triage", n: "new", "/": "search", "?": "help", " ": "viewer" };
  if (simple[key]) return { action: simple[key], pendingG: false };
  if (/^[1-4]$/.test(key)) return { action: `priority:${Number(key) - 1}`, pendingG: false };
  return { action: null, pendingG: false };
}

/** Letter to show after deciding `id`. `stays` = it is still in the list (skip, priority). Wraps to the start; null when nothing else is left. */
export function nextAfter(ids, id, stays) {
  const i = ids.indexOf(id);
  if (i < 0) return ids[0] ?? null;
  if (stays) return ids.length > 1 ? ids[(i + 1) % ids.length] : null;
  const rest = ids.filter((x) => x !== id);
  return rest[i] ?? rest[0] ?? null;
}

/** Move by one inside the list, no wrap; null id starts at the top. */
export function stepId(ids, id, dir) {
  if (!ids.length) return null;
  const i = ids.indexOf(id);
  return ids[Math.min(ids.length - 1, Math.max(0, i < 0 ? 0 : i + dir))];
}

/** Session progress for triage: how many decided of how many there were at the start. */
export const progress = (done, total) => ({ done, left: Math.max(0, total - done), pct: total ? Math.min(100, Math.round((done / total) * 100)) : 100 });

/** Last-in first-out history of reversible actions. */
export function undoStack(limit = 30) {
  const s = [];
  return { push(e) { s.push(e); if (s.length > limit) s.shift(); }, pop: () => s.pop(), peek: () => s[s.length - 1], get size() { return s.length; } };
}

/** Undo patches: the old values of the fields a patch touched, grouped so identical ones can go in one bulk call. */
export function undoGroups(before, patch) {
  const fields = Object.keys(patch).filter((k) => ["status", "note", "priority", "labels", "duplicate_of"].includes(k));
  // a status change clears duplicate_of, and a new duplicate_of sets the status: restore both together
  if (patch.status && !fields.includes("duplicate_of")) fields.push("duplicate_of");
  if (patch.duplicate_of !== undefined && !fields.includes("status")) fields.push("status");
  const groups = new Map();
  for (const i of before) {
    const prev = {};
    for (const k of fields) prev[k] = i[k] === undefined ? null : i[k];
    const key = JSON.stringify(prev);
    if (!groups.has(key)) groups.set(key, { ids: [], prev });
    groups.get(key).ids.push(i.id);
  }
  return [...groups.values()];
}

/** Sections per screen, biggest cluster first; letters without a screen go last. */
export function groupByScreen(items) {
  const by = new Map();
  for (const i of items) { const k = i.screen || ""; if (!by.has(k)) by.set(k, []); by.get(k).push(i); }
  return [...by.entries()].map(([screen, list]) => ({ screen, items: list }))
    .sort((a, b) => (!a.screen) - (!b.screen) || b.items.length - a.items.length || a.screen.localeCompare(b.screen));
}

/** Unique labels across letters, most used first, for autocomplete. */
export function knownLabels(items) {
  const n = new Map();
  for (const i of items) for (const l of i.labels || []) n.set(l, (n.get(l) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
}

/** "12" or "#12" in the duplicate picker means a letter id. */
export const searchId = (q) => { const m = /^#?(\d{1,9})$/.exec(String(q).trim()); return m ? Number(m[1]) : null; };

/** Size after the client-side resize: long side at most `max`, never enlarged, aspect kept. */
export function resizeDims(w, h, max = 1600) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/* Viewer maths: the image sits centred in the stage; view = {s: scale, x, y: pan in px from the centre}. */
export const fitScale = (sw, sh, iw, ih) => Math.min(1, sw / iw, sh / ih);
const clampAxis = (t, content, stage) => (content <= stage ? 0 : Math.min((content - stage) / 2, Math.max(-(content - stage) / 2, t)));
export const clampView = (v, sw, sh, iw, ih) => ({ s: v.s, x: clampAxis(v.x, iw * v.s, sw), y: clampAxis(v.y, ih * v.s, sh) });
/** Zoom by `factor` keeping the point (cx, cy), measured from the stage centre, under the pointer. */
export function zoomAt(v, factor, cx, cy, min, max = 8) {
  const s = Math.min(max, Math.max(min, v.s * factor));
  const k = s / v.s;
  return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

/** Same markdown as `postbox show` (packages/cli/src/index.ts), plus the decision; the photos are named, the CLI downloads them. */
export function brief(i) {
  const row = (k, v) => (v == null || v === "" || (Array.isArray(v) && !v.length) ? [] : [`- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`]);
  return [
    `# Feedback #${i.id}`,
    "",
    ...row("project", i.project), ...row("kind", i.kind), ...row("status", i.status),
    ...row("priority", i.priority == null ? "" : priorityLabel(i.priority).toLowerCase()), ...row("labels", i.labels),
    ...row("screen", i.screen),
    ...row("build", [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ")),
    ...row("platform", i.platform), ...row("device", i.device), ...row("os", i.os), ...row("url", i.url),
    ...row("created", i.created_at),
    ...(i.attachment_count ? [`Photos: ${i.attachment_count}, run postbox show ${i.id} to download them`] : []),
    "",
    "## Text",
    "",
    i.text,
    ...(i.note ? ["", "## Decision for the agent", "", i.note] : []),
    ...(i.duplicates?.length ? ["", "## Duplicates folded in", "", ...i.duplicates.map((d) => `- #${d.id}: ${d.text}`)] : []),
  ].join("\n");
}

/** One Markdown document for several letters, in the given order. */
export function briefMany(items) {
  if (items.length === 1) return brief(items[0]);
  return [`# Postbox brief: ${items.length} letters`, "", ...items.flatMap((i, n) => [...(n ? ["", "---", ""] : []), brief(i)])].join("\n");
}

/** Add `more` after `items`, skipping letters already there; order is the server's. */
export function appendItems(items, more) {
  const seen = new Set(items.map((i) => i.id));
  return [...items, ...more.filter((i) => !seen.has(i.id))];
}

/** Image for a list row: the small thumb when there is one, else the first image; null for text-only feedback. */
export function thumbPath(i) {
  if (!i.attachment_count) return null;
  return i.has_thumb ? `/api/feedback/${i.id}/thumb` : `/api/feedback/${i.id}/attachments/0`;
}

/** "+N" badge for the images beyond the one shown; empty for zero or one image. */
export const moreBadge = (i) => (i.attachment_count > 1 ? `+${i.attachment_count - 1}` : "");
