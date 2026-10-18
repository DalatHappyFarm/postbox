import { cleanToken, STATUS_LABEL, STATUS_VIEWS, KINDS, KIND_LABEL, PLATFORMS, PRIORITIES, priorityLabel, SORTS, TOKEN_KEY, migrateToken, firstLine, shortcutAction,
  decodeHash, encodeHash, stateQuery, listQuery, viewStatus, viewCount, inView, DEFAULT_STATE, nextAfter, stepId, progress, undoStack, undoGroups, groupByScreen, knownLabels,
  normalizeLabel, labelError, searchId, resizeDims, fitScale, clampView, zoomAt, relativeTime, brief, briefMany, appendItems, thumbPath, moreBadge } from "/lib.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: () => { try { return migrateToken(localStorage); } catch { return ""; } },
  set: (v) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (name) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
};
const btn = (label, { cls = "", ic = "", key = "", title = "", click } = {}) => {
  const b = el("button", cls);
  b.type = "button";
  if (ic) b.append(icon(ic));
  b.append(el("span", "", label));
  if (key) b.append(el("kbd", "", key));
  if (title) b.title = title;
  if (click) b.addEventListener("click", click);
  return b;
};
const mobile = () => matchMedia("(max-width:699px)").matches;
const typing = (t) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t.type === "checkbox"));

let token = store.get();
let S = decodeHash(location.hash); // filters + open letter + triage flag, mirrored in the URL hash
let items = [], cursor = null, counts = { status: {}, screen: [] };
let projects = [], loadSeq = 0, detail = null, ready = false, knownCounts = false, knownProjects = false;
let picked = new Set(), lastPicked = null;
let tri = { total: 0, done: 0 };
const undo = undoStack();
const dirty = new Set(); // letters changed locally since their detail was requested
const details = new Map(); // id -> full letter (attachments, duplicates); refreshed on open

class AuthError extends Error {}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}) } });
  if (res.status === 401) { signOut("This token was rejected. Paste the admin token again."); throw new AuthError(); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(`${res.status} ${msg}`);
  }
  return res;
}
const getJson = async (path) => (await api(path)).json();
/** Server message without the status code, for toasts. */
const why = (e) => String(e.message).replace(/^\d{3} /, "");
const send = async (method, path, body) => (await api(path, { method, body: JSON.stringify(body) })).json();

function signOut(message = "") {
  token = ""; store.set("");
  items = []; detail = null; picked.clear(); drops(true);
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("app").hidden = true; $("login").hidden = false;
  const err = $("login-error");
  err.textContent = message; err.hidden = !message;
  $("token").value = ""; $("token").focus();
  document.title = "Postbox";
}

/* ---------- images: blob URLs cached per letter (the API needs the token header, so <img src> cannot point at it) ---------- */

const blobCache = new Map(); // path -> Promise<blob url | null>
const blobUrl = (path) => {
  if (!blobCache.has(path)) blobCache.set(path, api(path).then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch(() => null));
  return blobCache.get(path);
};
const photoPaths = (i) => Array.from({ length: i.attachment_count || 0 }, (_, n) => `/api/feedback/${i.id}/attachments/${n}`);
/** Keep thumbs and the photos of the letters near the cursor; revoke the rest so memory stays flat. */
function drops(all = false) {
  const keep = new Set();
  if (!all) for (const id of [S.letter, ...neighbours(2)]) { const i = find(id); if (i) { photoPaths(i).forEach((p) => keep.add(p)); keep.add(thumbPath(i)); } }
  if (!all) for (const i of items) keep.add(thumbPath(i));
  for (const [p, pr] of blobCache) if (!keep.has(p)) { pr.then((u) => u && URL.revokeObjectURL(u)); blobCache.delete(p); }
}

/* ---------- lookups ---------- */

const find = (id) => items.find((i) => i.id === id) || (details.get(id) && details.get(id));
const boxName = (slug) => projects.find((p) => p.slug === slug)?.name || slug;
const ordered = () => (S.group ? groupByScreen(items).flatMap((g) => g.items) : items);
const orderedIds = () => ordered().map((i) => i.id);
function neighbours(n) {
  const ids = orderedIds(), i = ids.indexOf(S.letter);
  return i < 0 ? [] : ids.slice(i + 1, i + 1 + n);
}
const pill = (status) => el("span", `pill ${status}`, STATUS_LABEL[status] || status);
const prio = (n) => (n == null || n === 2 ? null : el("span", `prio p${n}`, priorityLabel(n)));
const buildOf = (i) => [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ");

/* ---------- URL hash ---------- */

function commit(push = false) {
  const h = encodeHash(S);
  if (h === (location.hash || "#/")) return;
  history[push ? "pushState" : "replaceState"](null, "", location.pathname + location.search + h);
}
const FILTER_KEYS = ["project", "status", "kind", "priority", "label", "source", "screen", "build", "q", "sort"];

function applyHash() {
  if (!ready) return;
  const n = decodeHash(location.hash);
  const refilter = FILTER_KEYS.some((k) => n[k] !== S[k]);
  const letter = n.letter !== S.letter, tr = n.triage !== S.triage, group = n.group !== S.group;
  S = n;
  if (tr) setMode();
  if (refilter) { $("q").value = S.q; loadList(); renderRail(); } else if (group) { renderList(); }
  if (letter || tr || refilter) showLetter();
  syncChrome();
}

function setFilter(patch) {
  const was = S.letter;
  S = { ...S, ...patch, letter: 0 };
  picked.clear(); lastPicked = null;
  commit(); syncChrome(); renderRail(); loadList();
  if (was) showLetter();
  closeRail();
}

/* ---------- rail: mailboxes and facets ---------- */

function renderRail() {
  const rail = $("rail");
  const frag = [];
  const section = (title, rows, hint) => {
    const s = el("section", "facet");
    const h = el("h2", "", title);
    if (hint) h.title = hint;
    const ul = el("ul");
    ul.append(...rows);
    s.append(h, ul);
    frag.push(s);
  };
  const row = (label, n, on, click, extra) => {
    const b = el("button");
    b.type = "button"; b.setAttribute("aria-pressed", String(on));
    b.append(el("span", "nm", label));
    if (extra) b.append(extra);
    if (n != null) b.append(el("span", n ? "count" : "count zero", String(n)));
    b.addEventListener("click", click);
    const li = el("li"); li.append(b);
    return li;
  };
  const unreadBy = (p) => p.counts?.new || 0;
  const unreadAll = projects.reduce((n, p) => n + unreadBy(p), 0);
  section("Mailboxes", [
    row("All mail", knownProjects ? unreadAll : null, !S.project, () => setFilter({ project: "" })),
    ...projects.map((p) => row(p.name, unreadBy(p), S.project === p.slug, () => setFilter({ project: p.slug }))),
  ], "Unread letters per mailbox");
  section("Status", STATUS_VIEWS.map((v) => row(v.label, knownCounts ? viewCount(v.key, counts.status) : null, S.status === v.key, () => setFilter({ status: v.key }))));
  section("Priority", [
    ...PRIORITIES.map((p) => row(p.label, null, S.priority === String(p.n), () => setFilter({ priority: S.priority === String(p.n) ? "" : String(p.n) }))),
    row("Not set", null, S.priority === "none", () => setFilter({ priority: S.priority === "none" ? "" : "none" })),
  ]);
  if (counts.screen.length || S.screen) {
    const shown = counts.screen.some((c) => c.screen === S.screen) || !S.screen ? counts.screen : [{ screen: S.screen, n: 0 }, ...counts.screen];
    section("Screen", shown.map((c) => row(c.screen, c.n, S.screen === c.screen, () => setFilter({ screen: S.screen === c.screen ? "" : c.screen }))), "Letters per screen, all statuses");
  }
  const labels = [...new Set([...(S.label ? [S.label] : []), ...knownLabels(items)])];
  if (labels.length) section("Label", labels.map((l) => row(l, null, S.label === l, () => setFilter({ label: S.label === l ? "" : l }))), "Labels found in the loaded letters");
  section("Source", [["app", "From an app"], ["web", "Added by hand"]].map(([k, t]) => row(t, null, S.source === k, () => setFilter({ source: S.source === k ? "" : k }))));
  section("Kind", KINDS.map((k) => row(KIND_LABEL[k], null, S.kind === k, () => setFilter({ kind: S.kind === k ? "" : k }))));
  rail.replaceChildren(...frag);
  document.title = unreadAll ? `(${unreadAll}) Postbox` : "Postbox";
}

const openRail = () => { document.body.classList.add("rail-open"); $("rail-back").hidden = false; $("filters-btn").setAttribute("aria-expanded", "true"); $("rail").querySelector("button")?.focus(); };
function closeRail() { document.body.classList.remove("rail-open"); $("rail-back").hidden = true; $("filters-btn").setAttribute("aria-expanded", "false"); }

async function loadProjects() {
  projects = await getJson("/api/projects");
  knownProjects = true;
  renderRail();
}

/* ---------- list ---------- */

function setMsg(title, body, retry) {
  const m = $("list-msg");
  m.replaceChildren();
  if (title) m.append(el("span", "big", title));
  if (body) m.append(document.createTextNode(body));
  if (retry) { const b = el("button", "", "Try again"); b.type = "button"; b.addEventListener("click", () => loadList()); m.append(el("br"), b); }
}

function skeletons() {
  $("list").replaceChildren(...Array.from({ length: 7 }, () => { const s = el("li", "skel"); s.setAttribute("aria-hidden", "true"); const d = el("div"); d.append(el("b"), el("b"), el("b")); s.append(el("i"), d); return s; }));
}

async function loadList(more = false) {
  const seq = ++loadSeq;
  if (!more) { items = []; cursor = null; setMsg(""); skeletons(); $("more").hidden = true; $("sum").textContent = ""; renderBulk(); }
  $("list").setAttribute("aria-busy", "true");
  try {
    const r = await getJson(`/api/feedback?${stateQuery(S, { cursor: more ? cursor : "" })}`);
    if (seq !== loadSeq) return;
    cursor = r.next_cursor;
    if (r.counts) { counts = { status: r.counts.status || {}, screen: r.counts.screen || [] }; knownCounts = true; }
    items = more ? appendItems(items, r.items) : r.items;
    $("more").hidden = !cursor;
    renderList(); renderRail();
    if (!more) { const t = tri.pending; tri.pending = false; if (t) startTriage(true); }
  } catch (e) {
    if (e instanceof AuthError || seq !== loadSeq) return;
    $("list").replaceChildren();
    setMsg("Could not load letters.", `${e.message}. Check your connection, then try again.`, true);
  } finally { if (seq === loadSeq) $("list").removeAttribute("aria-busy"); }
}

/** Refresh counts only (one cheap request) after changes, so the rail stays true without reloading the list. */
let countTimer = 0;
function refreshCounts() {
  clearTimeout(countTimer);
  countTimer = setTimeout(async () => {
    try {
      const [r, p] = await Promise.all([getJson(`/api/feedback?${stateQuery(S, { limit: 1 })}`), getJson("/api/projects")]);
      if (r.counts) counts = { status: r.counts.status || {}, screen: r.counts.screen || [] };
      projects = p; knownProjects = knownCounts = true; renderRail(); renderSummary();
    } catch {}
  }, 250);
}

function emptyCopy() {
  const filtered = FILTER_KEYS.some((k) => k !== "sort" && S[k] !== DEFAULT_STATE[k]);
  if (S.q) return ["No letter matches this search.", "Try fewer words, or clear the search."];
  if (filtered && S.status === "new" && !S.screen && !S.label) return ["All caught up.", "No unread letters here. New feedback lands in this mailbox, or add one with New letter."];
  if (filtered) return ["No letters match these filters.", "Remove a filter above to see more."];
  return ["No letters yet.", "When someone sends feedback it lands here. You can also add one by hand with New letter."];
}

function chipFor(k, label, clear) {
  const b = el("button", "chip");
  b.type = "button"; b.title = `Remove ${label}`;
  b.append(el("span", "", label), icon("x"));
  b.addEventListener("click", clear);
  return b;
}
function renderActive() {
  const box = $("active"), chips = [];
  const add = (k, label) => chips.push(chipFor(k, label, () => setFilter({ [k]: DEFAULT_STATE[k] })));
  if (S.project) add("project", boxName(S.project));
  if (S.status !== "open") add("status", STATUS_VIEWS.find((v) => v.key === S.status).label);
  if (S.priority) add("priority", S.priority === "none" ? "No priority" : priorityLabel(Number(S.priority)));
  if (S.screen) add("screen", S.screen);
  if (S.label) add("label", `#${S.label}`);
  if (S.source) add("source", S.source === "web" ? "By hand" : "From apps");
  if (S.kind) add("kind", KIND_LABEL[S.kind]);
  if (S.build) add("build", `Build ${S.build}`);
  box.hidden = !chips.length;
  box.replaceChildren(...chips);
}

function renderSummary() {
  const total = viewCount(S.status, counts.status);
  const plain = !S.screen && !S.label && !S.source && !S.priority && !S.build && !S.q;
  $("sum").textContent = !items.length ? "" : plain && total > items.length ? `${items.length} of ${total}` : `${items.length}${cursor ? "+" : ""} letter${items.length === 1 ? "" : "s"}`;
}

const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    seen.unobserve(e.target);
    const i = items.find((x) => x.id === Number(e.target.dataset.id));
    const path = i && thumbPath(i);
    if (!path) continue;
    blobUrl(path).then((u) => { const box = e.target.querySelector(".thumbbox"); if (u && box) box.replaceChildren(Object.assign(el("img", "thumb"), { src: u, alt: "" }), ...box.querySelectorAll(".badge")); });
  }
}, { rootMargin: "200px" });

function rowEl(i) {
  const li = el("li", `row${i.status === "new" ? " unread" : ""}${picked.has(i.id) ? " picked" : ""}`);
  li.dataset.id = i.id;
  if (i.id === S.letter) li.setAttribute("aria-current", "true");
  const cb = el("label", "cb"); const ck = el("input"); ck.type = "checkbox"; ck.checked = picked.has(i.id);
  ck.setAttribute("aria-label", `Select letter ${i.id}`);
  ck.addEventListener("click", (e) => { e.stopPropagation(); pick(i.id, e.shiftKey); });
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.append(ck);
  if (i.attachment_count) {
    const box = el("div", "thumbbox");
    box.append(el("div", "thumb"));
    if (moreBadge(i)) box.append(el("span", "badge", moreBadge(i)));
    li.append(cb, box);
  } else { const n = el("div", "noshot"); n.append(icon("mail")); li.append(cb, n); }
  const body = el("div", "body");
  const r1 = el("div", "r1");
  const first = el("a", "first", firstLine(i.text) || "(no text)");
  first.href = encodeHash({ ...S, letter: i.id });
  r1.append(first, el("span", "when", relativeTime(i.created_at)));
  const r2 = el("div", "r2");
  r2.append(el("span", "box", boxName(i.project)), el("span", "kind", KIND_LABEL[i.kind] || i.kind));
  if (i.status !== "new") r2.append(pill(i.status));
  const p = prio(i.priority); if (p) r2.append(p);
  for (const l of (i.labels || []).slice(0, 3)) r2.append(el("span", "lbl", l));
  if ((i.labels || []).length > 3) r2.append(el("span", "lbl more", `+${i.labels.length - 3}`));
  const meta = [i.screen, buildOf(i), i.platform].filter(Boolean).join(" · ");
  body.append(r1, r2, el("div", "r3", meta));
  li.append(body);
  li.addEventListener("click", (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); openLetter(i.id, true); });
  if (i.attachment_count) seen.observe(li);
  return li;
}

function renderList() {
  const ul = $("list");
  seen.disconnect();
  renderActive(); renderSummary();
  $("group").setAttribute("aria-pressed", String(S.group));
  $("pick-all").checked = items.length > 0 && items.every((i) => picked.has(i.id));
  if (!items.length) { ul.replaceChildren(); setMsg(...emptyCopy()); renderBulk(); return; }
  setMsg("");
  if (S.group) {
    ul.replaceChildren(...groupByScreen(items).flatMap((g) => {
      const h = el("li", "group");
      h.setAttribute("role", "presentation");
      h.append(el("span", "", g.screen || "No screen"), el("span", "count zero", String(g.items.length)));
      return [h, ...g.items.map(rowEl)];
    }));
  } else ul.replaceChildren(...items.map(rowEl));
  renderBulk();
  drops();
}

function paintRow(id) {
  const old = $("list").querySelector(`[data-id="${id}"]`), i = items.find((x) => x.id === id);
  if (old && i) old.replaceWith(rowEl(i));
}
function markCurrent() {
  for (const li of $("list").querySelectorAll("li.row")) { if (Number(li.dataset.id) === S.letter) li.setAttribute("aria-current", "true"); else li.removeAttribute("aria-current"); }
  $("list").querySelector(`[data-id="${S.letter}"]`)?.scrollIntoView({ block: "nearest" });
}

/* ---------- selection and the bulk bar ---------- */

function pick(id, range = false) {
  const ids = orderedIds();
  if (range && lastPicked != null && ids.includes(lastPicked)) {
    const [a, b] = [ids.indexOf(lastPicked), ids.indexOf(id)].sort((x, y) => x - y);
    for (const x of ids.slice(a, b + 1)) picked.add(x);
  } else if (picked.has(id)) picked.delete(id); else picked.add(id);
  lastPicked = id;
  for (const li of $("list").querySelectorAll("li.row")) { const on = picked.has(Number(li.dataset.id)); li.classList.toggle("picked", on); li.querySelector("input").checked = on; }
  $("pick-all").checked = items.length > 0 && items.every((i) => picked.has(i.id));
  renderBulk();
}

function bulkItems() { return ordered().filter((i) => picked.has(i.id)); }

function renderBulk() {
  const bar = $("bulk");
  picked = new Set([...picked].filter((id) => items.some((i) => i.id === id)));
  bar.hidden = !picked.size;
  $("list-pane").classList.toggle("has-bulk", !!picked.size);
  if (!picked.size) { bar.replaceChildren(); return; }
  const n = picked.size, sel = bulkItems();
  const status = el("select"); status.setAttribute("aria-label", "Set status of selected letters");
  status.append(new Option("Status...", ""), ...["new", "ready", "doing", "done", "wont_fix"].map((s) => new Option(STATUS_LABEL[s], s)));
  status.addEventListener("change", () => { if (status.value) act(bulkItems().map((i) => i.id), { status: status.value }, { verb: `${n} letters set to ${STATUS_LABEL[status.value]}` }); });
  const pr = el("select"); pr.setAttribute("aria-label", "Set priority of selected letters");
  pr.append(new Option("Priority...", ""), ...PRIORITIES.map((p) => new Option(p.label, String(p.n))), new Option("Clear", "none"));
  pr.addEventListener("change", () => { if (pr.value) act(bulkItems().map((i) => i.id), { priority: pr.value === "none" ? null : Number(pr.value) }, { verb: `Priority set on ${n} letters` }); });
  const lab = el("input"); lab.setAttribute("aria-label", "Add a label to selected letters"); lab.placeholder = "+ label"; lab.setAttribute("list", "labels-all"); lab.maxLength = 40; lab.autocomplete = "off";
  lab.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const l = normalizeLabel(lab.value);
    if (!l) { toast("Use letters, digits and dashes."); return; }
    act(bulkItems().map((i) => i.id), { labels_add: [l] }, { verb: `Label ${l} added to ${n} letters` });
  });
  const dl = el("datalist"); dl.id = "labels-all"; dl.append(...knownLabels(items).map((l) => new Option(l)));
  const sendBtn = btn("Send to agent queue", { cls: "primary", ic: "send", click: () => act(bulkItems().map((i) => i.id), { status: "ready" }, { verb: `${n} letters sent to the agent queue` }) });
  const dup = btn("Duplicate...", { ic: "dup", title: "Mark the selected letters as duplicates of another letter", click: () => pickDuplicate(sel.map((i) => i.id)) });
  const copy = btn(`Copy brief (${n})`, { ic: "copy", title: `Copy one brief for ${n} letter${n === 1 ? "" : "s"}`, click: () => copyText(briefMany(sel), `Brief for ${n} letters copied`) });
  const clear = btn("Clear", { cls: "ghost", ic: "x", click: () => { picked.clear(); renderList(); } });
  const lead = el("strong", "bulk-n", `${n} selected`);
  const g1 = el("div", "bulk-g"); g1.append(lead, clear);
  const g2 = el("div", "bulk-g grid2c"); g2.append(status, pr, lab, dl, dup);
  const g3 = el("div", "bulk-g"); g3.append(copy, sendBtn);
  bar.replaceChildren(g1, g2, g3);
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("Copy failed: the browser blocked the clipboard."); }
}

/* ---------- toast with undo ---------- */

let toastTimer = 0;
function toast(msg, onUndo, ms = 7000) {
  const t = $("toast");
  clearTimeout(toastTimer);
  t.replaceChildren(el("span", "", msg));
  if (onUndo) t.append(btn("Undo", { cls: "tundo", key: "z", click: doUndo }));
  t.hidden = false; t.style.bottom = "20px";
  // sit above a bar that would cover it (bulk bar, sticky decision bar on narrow panes)
  const tr = t.getBoundingClientRect();
  for (const bar of [$("bulk"), document.querySelector(".d-main")]) {
    const r = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
    if (r && r.height && r.left < tr.right && r.right > tr.left && r.top < tr.bottom && r.bottom > tr.top) t.style.bottom = `${innerHeight - r.top + 12}px`;
  }
  toastTimer = setTimeout(() => { t.hidden = true; }, onUndo ? ms : 3500);
}

/* ---------- actions: one path for single, bulk and triage ---------- */

const PATCH_FIELDS = ["status", "note", "priority", "labels", "duplicate_of"];

/** Local effect of a patch; labels_add / labels_remove only exist on bulk. */
function applyLocal(i, patch) {
  if (patch.status) i.status = patch.status;
  if ("note" in patch) i.note = patch.note;
  if ("priority" in patch) i.priority = patch.priority;
  if ("duplicate_of" in patch) { i.duplicate_of = patch.duplicate_of; if (patch.duplicate_of != null) i.status = "duplicate"; }
  if (patch.status && patch.status !== "duplicate" && !("duplicate_of" in patch)) i.duplicate_of = null;
  if (patch.labels) i.labels = [...patch.labels];
  if (patch.labels_add) i.labels = [...new Set([...(i.labels || []), ...patch.labels_add])];
  if (patch.labels_remove) i.labels = (i.labels || []).filter((l) => !patch.labels_remove.includes(l));
}
const snap = (i) => Object.fromEntries(["id", ...PATCH_FIELDS].map((k) => [k, Array.isArray(i[k]) ? [...i[k]] : i[k] ?? null]));

/** The bulk endpoint takes at most 200 ids per call. */
const bulk = async (ids, patch) => { for (let k = 0; k < ids.length; k += 200) await send("POST", "/api/feedback/bulk", { ids: ids.slice(k, k + 200), patch }); };

/** Send a patch for letters. `advance` moves the reading pane to the next letter when the letter leaves the list. */
async function remote(ids, patch) {
  const only = ["status", "priority", "labels_add", "labels_remove"];
  if (ids.length > 1 && Object.keys(patch).every((k) => only.includes(k))) return bulk(ids, patch);
  await Promise.all(ids.map((id) => {
    const p = { ...patch };
    if (p.labels_add || p.labels_remove) { const l = (find(id)?.labels || []); p.labels = l; delete p.labels_add; delete p.labels_remove; }
    return send("PATCH", `/api/feedback/${id}`, p);
  }));
}

async function act(ids, patch, { verb, advance = false, counts: decided = false } = {}) {
  const targets = ids.map((id) => find(id)).filter(Boolean);
  if (!targets.length) return;
  const before = targets.map(snap);
  const wasOpen = ids.includes(S.letter), origin = S.letter;
  const order = orderedIds();
  const nextId = advance && wasOpen ? nextAfter(order, S.letter, ids.length === 1 && inView(S.status, patchStatus(targets[0], patch))) : null;
  // optimistic: change the local copies first so the keyboard flow never waits for the network
  const removed = [];
  for (const i of targets) {
    dirty.add(i.id);
    applyLocal(i, patch);
    const d = details.get(i.id); if (d && d !== i) applyLocal(d, patch);
    if (!inView(S.status, i.status)) removed.push({ item: i, index: items.indexOf(i) });
  }
  removed.sort((a, b) => a.index - b.index);
  items = items.filter((i) => !removed.some((r) => r.item === i));
  for (const r of removed) picked.delete(r.item.id);
  if (removed.length) renderList(); else for (const i of targets) paintRow(i.id);
  if (decided) tri.done += 1;
  if (nextId != null) openLetter(nextId); else if (wasOpen) paintLetter();
  syncChrome();
  try {
    await remote(ids, patch);
  } catch (e) {
    if (e instanceof AuthError) return;
    for (const i of targets) { Object.assign(i, before.find((b) => b.id === i.id)); }
    for (const r of removed.sort((a, b) => a.index - b.index)) items.splice(Math.min(r.index, items.length), 0, r.item);
    if (decided) tri.done -= 1;
    renderList();
    if (wasOpen && S.letter !== origin) openLetter(origin); else if (S.letter) paintLetter();
    syncChrome();
    toast(`Could not save the change: ${why(e)}. Nothing was changed.`);
    return;
  }
  undo.push({ before, patch, removed, decided });
  toast(verb, true);
  refreshCounts();
  if (nextId != null && removed.length) topUp();
}

const patchStatus = (i, p) => (p.duplicate_of != null ? "duplicate" : p.status || i.status);

async function doUndo() {
  const e = undo.pop();
  if (!e) { toast("Nothing to undo."); return; }
  const live = e.before.map((b) => find(b.id)).filter(Boolean);
  for (const r of e.removed) if (!items.includes(r.item)) items.splice(Math.min(r.index, items.length), 0, r.item);
  const groups = undoGroups(e.before, e.patch);
  for (const i of live) { const b = e.before.find((x) => x.id === i.id); Object.assign(i, b); const d = details.get(i.id); if (d) Object.assign(d, b); }
  if (e.decided) tri.done = Math.max(0, tri.done - 1);
  renderList();
  if (e.before.length === 1) openLetter(e.before[0].id); else paintLetter();
  syncChrome();
  try {
    for (const g of groups) {
      const onlyStatus = g.ids.length > 1 && Object.keys(g.prev).every((k) => k === "status" || (k === "duplicate_of" && g.prev.duplicate_of === null)) && g.prev.status;
      if (onlyStatus) await bulk(g.ids, { status: g.prev.status });
      else await Promise.all(g.ids.map((id) => send("PATCH", `/api/feedback/${id}`, g.prev)));
    }
    toast("Undone.");
  } catch (err) {
    if (!(err instanceof AuthError)) toast(`Could not undo: ${why(err)}. Reload to see the real state.`);
  }
  refreshCounts();
}

/** In triage keep a few letters ahead of the cursor so the queue never runs dry mid-session. */
let moreBusy = false;
function topUp() {
  if (!cursor || moreBusy || neighbours(6).length >= 6) return;
  moreBusy = true;
  loadList(true).finally(() => { moreBusy = false; });
}

/* ---------- reading pane ---------- */

const photosOf = (i) => photoPaths(i);
let shown = null; // {id, photoIdx, node} reuse the photo area while the same letter repaints
let draft = { id: 0, text: "" };

function showLetter() {
  const id = S.letter;
  if (!id) { shown = null; detail = null; $("detail").replaceChildren(placeholder()); $("shell").classList.remove("open"); return; }
  $("shell").classList.add("open");
  const i = find(id);
  detail = i || null;
  if (i) paintLetter(true);
  else { const sk = el("div", "skeleton-detail"); sk.setAttribute("aria-busy", "true"); sk.append(el("i"), el("i"), el("i")); $("detail").replaceChildren(sk); }
  dirty.delete(id);
  getJson(`/api/feedback/${id}`).then((d) => {
    if (S.letter !== id) return;
    if (dirty.has(id)) for (const k of PATCH_FIELDS) delete d[k];
    details.set(id, d);
    const li = items.find((x) => x.id === id);
    if (li) Object.assign(li, { ...d, attachments: undefined, duplicates: undefined });
    detail = Object.assign(li || d, { attachments: d.attachments, duplicates: d.duplicates, locale: d.locale, updated_at: d.updated_at });
    paintLetter(!i);
  }).catch((e) => {
    if (e instanceof AuthError || S.letter !== id || i) return;
    const m = el("div", "empty");
    const gone = e.message.startsWith("404");
    m.append(el("strong", "", gone ? "This letter no longer exists." : "Could not open this letter."),
      el("span", "", gone ? "It may have been cleaned up. Pick another from the list." : `${e.message}. Check your connection, then try again.`));
    if (!gone) { const b = el("button", "", "Try again"); b.type = "button"; b.addEventListener("click", showLetter); m.append(b); }
    $("detail").replaceChildren(m);
  });
  markCurrent(); topUp();
  // warm the next letters so the next key press shows its photo at once
  for (const nid of neighbours(2)) { const n = find(nid); if (n) { photoPaths(n).slice(0, 1).forEach(blobUrl); } }
}

function placeholder() {
  const d = el("div", "empty");
  d.append(icon("mail"), el("strong", "", "Select a letter"), el("span", "", "Pick one from the list to read it, or start triage to go through the unread ones. Press ? for keyboard shortcuts."));
  return d;
}

function openLetter(id, push = false) {
  if (S.letter !== id) { saveDraft(); S.letter = id; commit(push && mobile()); }
  showLetter(); syncChrome();
}
function closeLetter() { saveDraft(); S.letter = 0; commit(); showLetter(); syncChrome(); }

function saveDraft() {
  const t = $("decision");
  if (!t || !detail || String(detail.id) !== t.dataset.id) return;
  const v = t.value.trim();
  if (v !== (detail.note || "")) { const id = detail.id; detail.note = v; const li = items.find((x) => x.id === id); if (li) li.note = v; send("PATCH", `/api/feedback/${id}`, { note: v }).catch(() => toast("Could not save the decision text.")); }
}

function paintLetter(fresh = false) {
  const i = detail; if (!i) return;
  const pane = $("detail");
  const keepText = $("decision")?.dataset.id === String(i.id) && !fresh ? $("decision").value : null;
  const hadFocus = !fresh && document.activeElement === $("decision");
  const wrap = el("article", `letter${i.attachment_count ? " has-photo" : ""}`);
  wrap.dataset.id = i.id;

  const head = el("div", "l-head");
  const back = btn("Letters", { cls: "back", ic: "back", click: () => (S.triage ? exitTriage() : closeLetter()) });
  back.setAttribute("aria-label", S.triage ? "Leave triage" : "Back to the letters");
  const copy = btn("Copy for agent", { cls: "copy", ic: "copy", title: "Copy this letter as a brief for the agent", click: () => copyText(brief(i), "Brief copied") });
  copy.setAttribute("aria-label", "Copy for agent");
  head.append(back, el("h2", "", `#${i.id} · ${boxName(i.project)}`), pill(i.status), el("span", "kind", KIND_LABEL[i.kind] || i.kind));
  if (i.source === "web") head.append(el("span", "kind", "added by hand"));
  head.append(el("span", "spacer"), copy);

  const photo = i.attachment_count ? photoArea(i) : null;

  const text = el("div", "l-text-wrap");
  text.append(...textBlock(i));
  const dl = el("dl", "ctx");
  const fields = [["Screen", i.screen], ["Build", buildOf(i)], ["Platform", i.platform], ["Device", i.device], ["OS", i.os], ["Locale", i.locale], ["URL", i.url], ["Created", new Date(i.created_at).toLocaleString()]];
  for (const [k, v] of fields) if (v) dl.append(el("dt", "", k), el("dd", "", v));
  text.append(dl);
  if (i.duplicates?.length) {
    const d = el("div", "dups"); d.append(el("strong", "", `${i.duplicates.length} duplicate${i.duplicates.length === 1 ? "" : "s"} folded in`));
    const ul = el("ul"); for (const x of i.duplicates) { const li = el("li"); const a = el("button", "linklike", `#${x.id} ${x.text}`); a.type = "button"; a.addEventListener("click", () => openLetter(x.id)); li.append(a); ul.append(li); }
    d.append(ul); text.append(d);
  }
  if (i.duplicate_of) {
    const d = el("p", "dupof"); d.append("Duplicate of ");
    const a = el("button", "linklike", `#${i.duplicate_of}`); a.type = "button"; a.addEventListener("click", () => openLetter(i.duplicate_of)); d.append(a);
    text.append(d);
  }

  const decide = decisionBlock(i, keepText);
  const side = el("div", "l-side");
  side.append(text, decide);
  wrap.append(head, ...(photo ? [photo] : []), side);
  pane.replaceChildren(wrap);
  if (fresh) { pane.scrollTop = 0; $("announce").textContent = `Letter ${i.id}: ${firstLine(i.text)}${S.triage ? `. ${Math.max(0, tri.total - tri.done)} left` : ""}`; }
  if (hadFocus) $("decision")?.focus();
}

/** First line as the headline, the rest as body: visual hierarchy photo, then headline, then detail. */
function textBlock(i) {
  const nl = i.text.indexOf("\n"), rest = nl < 0 ? "" : i.text.slice(nl).trim();
  return [el("h3", "l-title", nl < 0 ? i.text : i.text.slice(0, nl)), ...(rest ? [el("p", "l-text", rest)] : [])];
}

function photoArea(i) {
  if (shown?.id !== i.id) shown = { id: i.id, idx: 0 };
  const paths = photosOf(i);
  const idx = Math.min(shown.idx, paths.length - 1);
  const box = el("div", "photo");
  const stage = el("button", "stage");
  stage.type = "button"; stage.title = "Open photo viewer (space)"; stage.setAttribute("aria-label", `Open photo ${idx + 1} of ${paths.length} in the viewer`);
  const slot = el("span", "ph", "Loading photo"); stage.append(slot);
  blobUrl(paths[idx]).then((u) => {
    if (!slot.isConnected) return;
    if (!u) { slot.className = "ph bad"; slot.textContent = "This photo could not be loaded"; return; }
    slot.replaceWith(Object.assign(el("img", "main-img"), { src: u, alt: `Photo ${idx + 1} of ${paths.length}` }));
  });
  stage.addEventListener("click", () => openViewer(idx));
  box.append(stage);
  if (paths.length > 1) {
    const strip = el("div", "strip"); strip.setAttribute("role", "group"); strip.setAttribute("aria-label", "Photos");
    paths.forEach((p, n) => {
      const b = el("button", n === idx ? "on" : "");
      b.type = "button"; b.setAttribute("aria-label", `Show photo ${n + 1}`); b.setAttribute("aria-pressed", String(n === idx));
      blobUrl(p).then((u) => { if (u) b.append(Object.assign(el("img"), { src: u, alt: "" })); });
      b.addEventListener("click", () => { shown.idx = n; paintLetter(); });
      strip.append(b);
    });
    box.append(strip);
  }
  return box;
}

function decisionBlock(i, keepText) {
  const sec = el("section", "decide"); sec.setAttribute("aria-label", "Decision");
  const lab = el("label", "d-label", "Decision for the agent"); lab.htmlFor = "decision";
  const ta = el("textarea"); ta.id = "decision"; ta.dataset.id = i.id; ta.rows = 3; ta.maxLength = 4000;
  ta.value = keepText ?? (i.note || "");
  ta.placeholder = "What should the agent do? Add acceptance criteria. Needed before Ready, optional for the rest.";
  const hint = el("span", "d-hint small muted", "Enter sends it as Ready, Shift+Enter adds a line, Esc leaves the box");
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); ta.blur(); }
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ta.blur(); decide("ready"); }
  });
  ta.addEventListener("blur", saveDraft);
  const note = el("div", "d-note");
  note.append(lab, ta, hint);
  sec.append(note);

  const main = el("div", "d-main");
  main.append(
    btn("Ready for agent", { cls: `big ready${i.status === "ready" ? " on" : ""}`, ic: "send", key: "r", click: readyKey }),
    btn("Won't fix", { cls: `big${i.status === "wont_fix" ? " on" : ""}`, ic: "ban", key: "w", click: () => decide("wont") }),
    btn("Duplicate of...", { cls: `big${i.status === "duplicate" ? " on" : ""}`, ic: "dup", key: "d", click: () => decide("dup") }),
  );
  sec.append(main);

  const rest = el("div", "d-rest");
  const row = el("div", "d-row");
  const pg = el("div", "seg"); pg.setAttribute("role", "radiogroup"); pg.setAttribute("aria-label", "Priority");
  PRIORITIES.forEach((p) => {
    const b = el("button"); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(i.priority === p.n));
    b.append(el("kbd", "", String(p.n + 1)), document.createTextNode(p.label));
    b.addEventListener("click", () => setPriority(p.n));
    pg.append(b);
  });
  row.append(el("span", "d-cap", "Priority"), pg);

  const lrow = el("div", "d-row");
  const chips = el("div", "lbls");
  for (const l of i.labels || []) {
    const c = el("span", "lbl rm"); c.append(el("span", "", l));
    const x = el("button"); x.type = "button"; x.setAttribute("aria-label", `Remove label ${l}`); x.append(icon("x"));
    x.addEventListener("click", () => act([i.id], { labels: i.labels.filter((y) => y !== l) }, { verb: `Label ${l} removed` }));
    c.append(x); chips.append(c);
  }
  const addBtn = btn("Label", { cls: "small-btn", ic: "tag", key: "l", click: () => focusLabel() });
  const form = el("form", "lform"); form.hidden = true;
  const inp = el("input"); inp.id = "label-in"; inp.setAttribute("list", "labels-dl"); inp.maxLength = 40; inp.placeholder = "new-label"; inp.autocomplete = "off"; inp.setAttribute("aria-label", "New label");
  const dl = el("datalist"); dl.id = "labels-dl"; dl.append(...knownLabels(items).filter((l) => !(i.labels || []).includes(l)).map((l) => new Option(l)));
  const err = el("span", "error small"); err.setAttribute("role", "alert");
  form.append(inp, dl, err);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const l = normalizeLabel(inp.value), why = labelError(l, i.labels || []);
    if (why) { err.textContent = why; return; }
    act([i.id], { labels: [...(i.labels || []), l] }, { verb: `Label ${l} added` });
  });
  inp.addEventListener("input", () => { err.textContent = ""; });
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); form.hidden = true; addBtn.hidden = false; } });
  lrow.append(el("span", "d-cap", "Labels"), chips, addBtn, form);

  const more = el("div", "d-row d-more");
  more.append(
    btn("Skip", { ic: "skip", key: "s", title: "Keep for later and show the next letter", click: () => decide("skip") }),
    btn("Done", { ic: "check", key: "e", click: () => decide("done") }),
    btn("Back to unread", { ic: "back", key: "u", click: () => decide("unread") }),
    btn("Undo", { ic: "undo", key: "z", click: doUndo }),
  );
  rest.append(row, lrow, more);
  sec.append(rest);
  return sec;
}

function focusLabel() {
  const f = $("label-in")?.form; if (!f) return;
  f.hidden = false; f.previousElementSibling.hidden = true; $("label-in").focus();
}

function setPriority(n) {
  if (!detail) return;
  const same = detail.priority === n;
  act([detail.id], { priority: same ? null : n }, { verb: same ? "Priority cleared" : `Priority set to ${priorityLabel(n).toLowerCase()}` });
}

/** One decision on the open letter; decisions advance to the next letter, modifiers (priority, labels) do not. */
function decide(kind) {
  const i = detail; if (!i) return;
  const text = $("decision")?.dataset.id === String(i.id) ? $("decision").value.trim() : (i.note || "");
  const n = (note) => ({ ...(text !== (i.note || "") ? { note } : {}) });
  if (kind === "ready") act([i.id], { status: "ready", ...n(text) }, { verb: `#${i.id} is ready for the agent`, advance: true, counts: true });
  else if (kind === "wont") act([i.id], { status: "wont_fix", ...n(text) }, { verb: `#${i.id} marked won't fix`, advance: true, counts: true });
  else if (kind === "done") act([i.id], { status: "done", ...n(text) }, { verb: `#${i.id} marked done`, advance: true, counts: true });
  else if (kind === "unread") act([i.id], { status: "new" }, { verb: `#${i.id} back to unread` });
  else if (kind === "dup") pickDuplicate([i.id]);
  else if (kind === "skip") skip();
}

function skip() {
  const id = S.letter, next = nextAfter(orderedIds(), id, true);
  if (next == null) { toast("This is the last letter."); return; }
  openLetter(next);
}

/** `r`: with an empty decision, ask for it first (one decision per letter, never Ready without a word to the agent by accident). */
let asked = 0;
function readyKey() {
  const i = detail; if (!i) return;
  const box = $("decision");
  if (box && !box.value.trim() && !i.note && asked !== i.id) { asked = i.id; box.focus(); return; }
  decide("ready");
}

/* ---------- duplicate picker ---------- */

let dupFor = [], dupHits = [], dupSel = 0, dupSeq = 0, dupTimer = 0;
function pickDuplicate(ids) {
  if (ids.some((id) => find(id)?.duplicates?.length)) { toast("Other letters are duplicates of this one, so it must stay the original."); return; }
  const projs = new Set(ids.map((id) => find(id)?.project));
  if (projs.size !== 1) { toast("Select letters from one mailbox to mark duplicates."); return; }
  dupFor = ids;
  const d = $("dupdlg"); $("dup-q").value = ""; dupHits = []; dupSel = 0;
  d.showModal(); $("dup-q").focus(); searchDup();
}
async function searchDup() {
  const seq = ++dupSeq, q = $("dup-q").value.trim();
  const project = find(dupFor[0])?.project;
  $("dup-msg").textContent = "Searching...";
  try {
    const id = searchId(q);
    const [list, byId] = await Promise.all([
      getJson(`/api/feedback?${listQuery({ project, q: id ? "" : q, status: "new,ready,doing,done,wont_fix", limit: 8, sort: "new" })}`),
      id ? getJson(`/api/feedback/${id}`).catch(() => null) : null,
    ]);
    if (seq !== dupSeq) return;
    const hits = [...(byId && byId.project === project ? [byId] : []), ...list.items].filter((x, n, a) => !dupFor.includes(x.id) && x.status !== "duplicate" && a.findIndex((y) => y.id === x.id) === n);
    dupHits = hits.slice(0, 8); dupSel = 0;
    $("dup-msg").textContent = dupHits.length ? "" : q ? "No letter found. Search by words from its text, or by #id." : "No other letters in this mailbox.";
    paintDup();
  } catch (e) { if (!(e instanceof AuthError) && seq === dupSeq) $("dup-msg").textContent = `Could not search (${e.message}).`; }
}
function paintDup() {
  $("dup-list").replaceChildren(...dupHits.map((h, n) => {
    const li = el("li", n === dupSel ? "sel" : ""); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(n === dupSel)); li.id = `dup-${h.id}`;
    li.append(el("span", "did", `#${h.id}`), el("span", "dtx", firstLine(h.text) || "(no text)"), pill(h.status));
    li.addEventListener("click", () => chooseDup(h.id));
    return li;
  }));
  const s = dupHits[dupSel]; if (s) $("dup-q").setAttribute("aria-activedescendant", `dup-${s.id}`);
  $("dup-list").children[dupSel]?.scrollIntoView({ block: "nearest" });
}
function chooseDup(target) {
  $("dup-q").blur(); $("dupdlg").close();
  const ids = dupFor, adv = ids.length === 1;
  act(ids, { duplicate_of: target }, { verb: `${ids.length === 1 ? `#${ids[0]}` : `${ids.length} letters`} marked duplicate of #${target}`, advance: adv, counts: adv });
}
$("dup-q").addEventListener("input", () => { clearTimeout(dupTimer); dupTimer = setTimeout(searchDup, 200); });
$("dup-q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (dupHits.length) { dupSel = (dupSel + (e.key === "ArrowDown" ? 1 : -1) + dupHits.length) % dupHits.length; paintDup(); } }
  else if (e.key === "Enter") { e.preventDefault(); if (dupHits[dupSel]) chooseDup(dupHits[dupSel].id); }
});
$("dup-cancel").addEventListener("click", () => $("dupdlg").close());

/* ---------- triage mode ---------- */

function setMode() {
  document.body.classList.toggle("triage", S.triage);
  $("tbar").hidden = !S.triage;
  $("triage-btn").hidden = S.triage;
}

function listTotal() {
  const plain = !S.screen && !S.label && !S.source && !S.priority && !S.build && !S.q;
  return plain ? Math.max(items.length, viewCount(S.status, counts.status)) : items.length;
}

/** Start from the oldest unread; on a reload from the URL keep what the URL says. */
function startTriage(keep = false) {
  if (!keep && (S.status !== "new" || S.sort !== "old")) {
    S = { ...S, status: "new", sort: "old", letter: 0, triage: true };
    tri = { total: 0, done: 0, pending: true };
    picked.clear(); setMode(); commit(); renderRail(); loadList(); syncChrome();
    return;
  }
  S.triage = true;
  tri = { total: listTotal(), done: 0 };
  setMode();
  const first = S.letter && find(S.letter) ? S.letter : orderedIds()[0];
  if (first == null) { exitTriage(); toast("Nothing to triage in this view."); return; }
  S.letter = first; commit(); showLetter(); syncChrome();
}
function exitTriage() {
  S.triage = false; setMode(); commit(); syncChrome();
  if (mobile()) closeLetter();
}
function paintTriage() {
  if (!S.triage) return;
  const p = progress(tri.done, Math.max(tri.total, tri.done));
  $("tprog").style.width = `${p.pct}%`;
  $("tbar").querySelector(".prog").setAttribute("aria-valuenow", String(p.pct));
  $("tsum").textContent = items.length ? `${p.done} decided, ${p.left} left` : `${p.done} decided, all clear`;
  if (!items.length && !$("list-msg").textContent) $("list-msg").textContent = "";
  if (!items.length) {
    const d = el("div", "empty done");
    d.append(icon("check"), el("strong", "", "Triage finished."), el("span", "", `${p.done} letter${p.done === 1 ? "" : "s"} decided this session. Letters set to Ready are waiting for the agent.`));
    d.append(btn("Leave triage", { cls: "primary", click: exitTriage }));
    $("detail").replaceChildren(d); $("shell").classList.add("open");
  }
}

function syncChrome() {
  if ($("sort").value !== S.sort) $("sort").value = S.sort;
  if (document.activeElement !== $("q") && $("q").value.trim() !== S.q) $("q").value = S.q;
  paintTriage(); markCurrent();
}

/* ---------- photo viewer ---------- */

const V = { i: null, idx: 0, nw: 1, nh: 1, view: { s: 1, x: 0, y: 0 }, fit: true, drag: null, panel: true };
const stageSize = () => { const r = $("vstage").getBoundingClientRect(); return [r.width, r.height]; };

function openViewer(idx = 0) {
  const i = detail; if (!i?.attachment_count) return;
  V.i = i; $("viewer").showModal(); V.panel = innerWidth >= 900 || V.panel && innerWidth >= 700;
  paintSide(); showPhoto(idx);
  $("vmain").focus({ preventScroll: true });
}
async function showPhoto(n) {
  const paths = photosOf(V.i); V.idx = stepId(paths.map((_, k) => k), n, 0);
  $("v-prev").disabled = V.idx === 0; $("v-next").disabled = V.idx === paths.length - 1;
  $("v-count").textContent = `${V.idx + 1} / ${paths.length}`; $("v-count").hidden = paths.length < 2;
  const img = $("vimg"); img.style.visibility = "hidden";
  const u = await blobUrl(paths[V.idx]);
  if (!$("viewer").open) return;
  img.onload = () => { V.nw = img.naturalWidth || 1; V.nh = img.naturalHeight || 1; img.style.width = `${V.nw}px`; img.style.height = `${V.nh}px`; img.style.margin = `${-V.nh / 2}px 0 0 ${-V.nw / 2}px`; fitView(); img.style.visibility = "visible"; };
  img.alt = `Photo ${V.idx + 1} of ${paths.length}`; img.src = u || "";
  if (!u) { $("v-zoom").textContent = "Could not load this photo"; }
}
const minScale = () => { const [w, h] = stageSize(); return fitScale(w, h, V.nw, V.nh); };
function paintView() {
  const [w, h] = stageSize();
  V.view = clampView(V.view, w, h, V.nw, V.nh);
  $("vimg").style.transform = `translate(${V.view.x}px, ${V.view.y}px) scale(${V.view.s})`;
  $("v-zoom").textContent = `${Math.round(V.view.s * 100)}%`;
  $("v-fit").setAttribute("aria-pressed", String(V.fit));
  $("vstage").classList.toggle("can-pan", V.view.s > minScale() + 0.001);
}
function fitView() { V.fit = true; V.view = { s: minScale(), x: 0, y: 0 }; paintView(); }
function zoomBy(f, cx = 0, cy = 0) { V.fit = false; V.view = zoomAt(V.view, f, cx, cy, minScale()); if (V.view.s <= minScale() + 0.001) V.fit = true; paintView(); }
function actual(cx = 0, cy = 0) { V.fit = false; V.view = zoomAt(V.view, 1 / V.view.s, cx, cy, Math.min(1, minScale())); paintView(); }
function paintSide() {
  const i = V.i, side = $("v-side");
  $("viewer").classList.toggle("no-side", !V.panel);
  $("v-info").setAttribute("aria-pressed", String(V.panel));
  const dl = el("dl", "ctx");
  for (const [k, v] of [["Screen", i.screen], ["Build", buildOf(i)], ["Platform", i.platform], ["Device", i.device], ["OS", i.os], ["Status", STATUS_LABEL[i.status]], ["Priority", i.priority == null ? "" : priorityLabel(i.priority)]]) if (v) dl.append(el("dt", "", k), el("dd", "", v));
  side.replaceChildren(el("h2", "", `#${i.id} · ${boxName(i.project)}`), ...textBlock(i), dl, ...(i.note ? [el("h3", "", "Decision for the agent"), el("p", "", i.note)] : []));
}
const rel = (e) => { const r = $("vstage").getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };
$("vstage").addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = rel(e); zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), x, y); }, { passive: false });
$("vstage").addEventListener("pointerdown", (e) => { if (e.button) return; V.drag = { x: e.clientX, y: e.clientY, vx: V.view.x, vy: V.view.y, moved: false }; $("vstage").setPointerCapture(e.pointerId); $("vstage").classList.add("drag"); });
$("vstage").addEventListener("pointermove", (e) => { const d = V.drag; if (!d) return; d.moved = true; V.view = { ...V.view, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }; paintView(); });
const endDrag = () => { V.drag = null; $("vstage").classList.remove("drag"); };
$("vstage").addEventListener("pointerup", endDrag); $("vstage").addEventListener("pointercancel", endDrag);
$("vstage").addEventListener("dblclick", (e) => { const [x, y] = rel(e); if (V.view.s > minScale() + 0.001) fitView(); else actual(x, y); });
$("v-fit").addEventListener("click", fitView); $("v-100").addEventListener("click", () => actual());
$("v-in").addEventListener("click", () => zoomBy(1.25)); $("v-out").addEventListener("click", () => zoomBy(0.8));
$("v-prev").addEventListener("click", () => showPhoto(V.idx - 1)); $("v-next").addEventListener("click", () => showPhoto(V.idx + 1));
$("v-info").addEventListener("click", () => { V.panel = !V.panel; paintSide(); requestAnimationFrame(() => (V.fit ? fitView() : paintView())); });
$("v-close").addEventListener("click", () => $("viewer").close());
$("viewer").addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "+" || k === "=") zoomBy(1.25); else if (k === "-" || k === "_") zoomBy(0.8);
  else if (k === "0") fitView(); else if (k === "1") actual();
  else if (k === "ArrowLeft") showPhoto(V.idx - 1); else if (k === "ArrowRight") showPhoto(V.idx + 1);
  else if (k === "i") $("v-info").click();
  else return;
  e.preventDefault();
});
$("viewer").addEventListener("close", () => { shown = shown && { ...shown, idx: V.idx }; if (V.i && detail?.id === V.i.id) paintLetter(); });
addEventListener("resize", () => { if ($("viewer").open) { V.fit ? fitView() : paintView(); } });

/* ---------- new letter ---------- */

const np = { files: [], thumb: null, limits: { max_attachments: 8, max_text: 4000 } };

function newLetter() {
  const d = $("newdlg");
  $("new-form").reset(); np.files.forEach((f) => URL.revokeObjectURL(f.url)); np.files = []; np.thumb = null;
  $("n-project").replaceChildren(...projects.map((p) => new Option(p.name, p.slug)));
  $("n-project").value = S.project || projects[0]?.slug || "";
  $("n-platform").replaceChildren(new Option("Not set", ""), ...PLATFORMS.map((p) => new Option(p, p)));
  setKind("bug"); paintPreviews(); $("n-error").hidden = true; $("n-note").textContent = "";
  d.showModal(); $("n-text").focus();
  api("/api/limits").then((r) => r.json()).then((l) => { np.limits = { ...np.limits, ...l }; $("n-text").maxLength = l.max_text; }).catch(() => {});
}
function setKind(k) {
  np.kind = k;
  $("n-kind").replaceChildren(...KINDS.map((x) => { const b = el("button", "", KIND_LABEL[x]); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(x === k)); b.addEventListener("click", () => setKind(x)); return b; }));
}
function paintPreviews() {
  $("n-previews").replaceChildren(...np.files.map((f, n) => {
    const li = el("li"); const im = Object.assign(el("img"), { src: f.url, alt: `Photo ${n + 1}` });
    const x = el("button"); x.type = "button"; x.setAttribute("aria-label", `Remove photo ${n + 1}`); x.append(icon("x"));
    x.addEventListener("click", () => { URL.revokeObjectURL(f.url); np.files.splice(n, 1); np.thumb = null; paintPreviews(); });
    li.append(im, x, el("span", "sz", `${f.w}x${f.h}, ${Math.round(f.blob.size / 1024)} KB`));
    return li;
  }));
  const left = np.limits.max_attachments - np.files.length;
  $("n-note").textContent = np.files.length ? `${np.files.length} photo${np.files.length === 1 ? "" : "s"}, resized to 1600 px. ${left} more allowed.` : "";
}
async function toJpeg(file, max, q) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { w, h } = resizeDims(bmp.width, bmp.height, max);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", q));
  if (!blob) throw new Error("encode failed");
  return { blob, w, h };
}
async function addFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const room = np.limits.max_attachments - np.files.length;
  const err = $("n-error"); err.hidden = true;
  for (const f of imgs.slice(0, Math.max(0, room))) {
    try { const r = await toJpeg(f, 1600, 0.7); np.files.push({ ...r, url: URL.createObjectURL(r.blob), src: f }); }
    catch { err.textContent = `Could not read ${f.name || "that image"}. Try a PNG or JPEG.`; err.hidden = false; }
  }
  if (imgs.length > room) { err.textContent = `Only ${np.limits.max_attachments} photos per letter; the rest were skipped.`; err.hidden = false; }
  np.thumb = null; paintPreviews();
}
$("newdlg").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.some((f) => f.type.startsWith("image/"))) return;
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
  addFiles(files);
});
const drop = $("n-drop");
drop.addEventListener("click", () => $("n-file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("n-file").click(); } });
$("n-file").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
for (const ev of ["dragenter", "dragover"]) $("newdlg").addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) $("newdlg").addEventListener(ev, (e) => { if (ev === "drop" || e.target === $("newdlg")) drop.classList.remove("over"); });
$("newdlg").addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
$("n-cancel").addEventListener("click", () => $("newdlg").close());
$("newdlg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("new-form").requestSubmit(); } });
$("new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("n-error"), text = $("n-text").value.trim(), project = $("n-project").value;
  if (!text) { err.textContent = "Write what happened first."; err.hidden = false; $("n-text").focus(); return; }
  if (!project) { err.textContent = "Pick a mailbox."; err.hidden = false; return; }
  const save = $("n-save"); save.disabled = true; err.hidden = true;
  try {
    const meta = { project, kind: np.kind, text, source: "web" };
    for (const [k, id] of [["screen", "n-screen"], ["build", "n-build"], ["platform", "n-platform"], ["device", "n-device"]]) if ($(id).value.trim()) meta[k] = $(id).value.trim();
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    np.files.forEach((f, n) => form.append("photo", f.blob, `photo-${n + 1}.jpg`));
    if (np.files.length) { const t = await toJpeg(np.files[0].blob, 320, 0.6); form.append("thumb", t.blob, "thumb.jpg"); }
    const { id } = await (await api("/api/feedback", { method: "POST", body: form })).json();
    $("newdlg").close();
    toast(`Letter #${id} added.`);
    const switchTo = project !== S.project && S.project ? project : S.project;
    S = { ...S, project: switchTo, status: "open", kind: "", priority: "", label: "", source: "", screen: "", build: "", q: "", letter: 0 };
    $("q").value = ""; await Promise.all([loadProjects(), loadList()]);
    if (!items.some((i) => i.id === id)) items.unshift(...[await getJson(`/api/feedback/${id}`)]);
    renderList(); openLetter(id);
  } catch (x) {
    if (!(x instanceof AuthError)) { err.textContent = `Could not add the letter (${x.message}). Your text and photos are still here, try again.`; err.hidden = false; }
  } finally { save.disabled = false; }
});

/* ---------- theme ---------- */

const dark = () => ($("theme").dataset.mode || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
function paintTheme() {
  $("theme").dataset.mode = document.documentElement.dataset.theme || "";
  const d = dark();
  $("theme").querySelector("use").setAttribute("href", d ? "#i-sun" : "#i-moon");
  $("theme").setAttribute("aria-label", d ? "Switch to light theme" : "Switch to dark theme");
}
$("theme").addEventListener("click", () => {
  const next = dark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("postbox_theme", next); } catch {}
  paintTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintTheme);

/* ---------- keyboard ---------- */

let pendingG = false, gTimer = 0;
function move(dir) {
  const next = stepId(orderedIds(), S.letter, dir);
  if (next == null) return;
  if (S.letter === next) return;
  openLetter(next);
}

document.addEventListener("keydown", (e) => {
  if ($("app").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return; // each dialog owns its keys; Esc closes natively
  const t = e.target;
  if (e.key === "Escape") {
    if (typing(t)) { t.blur(); return; }
    if (document.body.classList.contains("rail-open")) closeRail();
    else if (S.triage) exitTriage();
    else if (S.letter) closeLetter();
    else if (picked.size) { picked.clear(); renderList(); }
    return;
  }
  if (typing(t)) return;
  const r = shortcutAction(e.key, pendingG);
  pendingG = r.pendingG; clearTimeout(gTimer);
  if (pendingG) gTimer = setTimeout(() => { pendingG = false; }, 1500);
  const a = r.action;
  if (!a) return;
  if ((a === "open" || a === "viewer") && /^(BUTTON|A|INPUT)$/.test(t.tagName)) return; // a focused control keeps its own Enter and Space
  e.preventDefault();
  const has = !!detail && !!S.letter;
  if (a === "next") move(1);
  else if (a === "prev") move(-1);
  else if (a === "open") { const id = S.letter || orderedIds()[0]; if (id) openLetter(id); }
  else if (a === "search") $("q").focus();
  else if (a === "help") $("keys").showModal();
  else if (a === "allMail") setFilter({ project: "" });
  else if (a === "new") newLetter();
  else if (a === "triage") (S.triage ? exitTriage() : startTriage());
  else if (a === "undo") doUndo();
  else if (a === "select") { const id = S.letter || orderedIds()[0]; if (id) pick(id, false); }
  else if (a === "viewer") { if (has && detail.attachment_count) openViewer(shown?.id === detail.id ? shown.idx : 0); }
  else if (!has) return;
  else if (a === "ready") readyKey();
  else if (a === "wont") decide("wont");
  else if (a === "dup") decide("dup");
  else if (a === "done") decide("done");
  else if (a === "skip") decide("skip");
  else if (a === "unread") decide("unread");
  else if (a === "label") focusLabel();
  else if (a.startsWith("priority:")) setPriority(Number(a.slice(9)));
});

/* ---------- boot ---------- */

async function start() {
  $("login").hidden = true; $("app").hidden = false;
  ready = true;
  S = decodeHash(location.hash);
  $("q").value = S.q;
  $("sort").replaceChildren(...SORTS.map((o) => new Option(o.label, o.key))); $("sort").value = S.sort;
  const wantTriage = S.triage;
  S.triage = false; setMode();
  renderRail(); showLetter();
  knownCounts = knownProjects = false;
  const names = loadProjects().then(() => items.length && renderList()).catch((e) => { if (!(e instanceof AuthError)) toast(`Could not load the mailboxes (${why(e)}).`); });
  if (wantTriage) { tri = { total: 0, done: 0, pending: false }; }
  await Promise.all([names, loadList()]);
  if (wantTriage) startTriage(true);
  else if (S.letter) showLetter();
}

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = cleanToken($("token").value);
  if (!token) return;
  store.set(token); $("login-error").hidden = true;
  start();
});
$("signout").addEventListener("click", () => signOut());
$("brand").addEventListener("click", (e) => { e.preventDefault(); if (S.triage) exitTriage(); setFilter({ ...DEFAULT_STATE }); $("q").value = ""; });
let qTimer = 0;
$("q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 280); });
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(qTimer); setFilter({ q: e.target.value.trim() }); e.target.blur(); } });
$("sort").addEventListener("change", (e) => setFilter({ sort: e.target.value }));
$("group").addEventListener("click", () => { S.group = !S.group; commit(); renderList(); markCurrent(); });
$("pick-all").addEventListener("change", (e) => { if (e.target.checked) items.forEach((i) => picked.add(i.id)); else picked.clear(); renderList(); });
$("more").addEventListener("click", () => loadList(true));
$("help").addEventListener("click", () => $("keys").showModal());
$("keys-close").addEventListener("click", () => $("keys").close());
$("new-btn").addEventListener("click", newLetter);
$("triage-btn").addEventListener("click", () => startTriage());
$("texit").addEventListener("click", exitTriage);
$("filters-btn").addEventListener("click", () => (document.body.classList.contains("rail-open") ? closeRail() : openRail()));
$("rail-back").addEventListener("click", closeRail);
for (const d of document.querySelectorAll("dialog:not(#viewer)")) d.addEventListener("click", (e) => { if (e.target === d && d.id !== "newdlg") d.close(); });
window.addEventListener("popstate", applyHash);
window.addEventListener("hashchange", applyHash);
window.addEventListener("pagehide", saveDraft);
paintTheme();
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
for (const k of document.querySelectorAll(".mod")) k.textContent = mac ? "Cmd" : "Ctrl";

if (token) start(); else { $("login").hidden = false; $("token").focus(); }
