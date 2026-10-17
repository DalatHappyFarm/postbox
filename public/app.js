import { cleanToken, STATUSES, STATUS_LABEL, KINDS, KIND_LABEL, TABS, tabStatus, TOKEN_KEY, migrateToken, firstLine, matchesSearch, unreadCounts, shortcutAction, stepIndex,
  statusStreams, listQuery, relativeTime, brief, mergeItems, thumbPath, moreBadge } from "/lib.js";

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

let token = store.get();
let items = [];
let cursors = {}; // per status stream: next cursor or null when exhausted
let selected = null; // id highlighted in the list
let detail = null; // letter shown in the reading pane
let loadSeq = 0;
let tab = "open", kind = "", project = "", query = "";
let projects = [], unread = { by: {}, total: 0, more: false };
const thumbs = new Map(); // list image path -> Promise<blob url | null>, revoked when the list is reloaded
let seen = null; // IntersectionObserver of the current list
let imgs = null; // {id, dead, urls: Promise<blob url | null>[]} for the open letter
let lbIndex = 0;

class AuthError extends Error {}

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 401) { signOut("This token was rejected. Paste the admin token again."); throw new AuthError(); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(`${res.status} ${msg}`);
  }
  return res;
}

function signOut(message = "") {
  token = ""; store.set("");
  items = []; detail = null; selected = null; dropThumbs(); dropImages();
  $("lightbox").open && $("lightbox").close();
  $("app").hidden = true; $("login").hidden = false;
  const err = $("login-error");
  err.textContent = message; err.hidden = !message;
  $("token").value = ""; $("token").focus();
  document.title = "Postbox";
}

// Blob URLs hold the image in memory until revoked: thumbs live as long as the list, photos as long as the letter.
async function blobUrl(path) {
  try { return URL.createObjectURL(await (await api(path)).blob()); } catch { return null; }
}

function dropThumbs() {
  seen?.disconnect();
  for (const p of thumbs.values()) p.then((u) => u && URL.revokeObjectURL(u));
  thumbs.clear();
}

function dropImages() {
  if (!imgs) return;
  imgs.dead = true;
  for (const p of imgs.urls) p.then((u) => u && URL.revokeObjectURL(u));
  imgs = null;
}

/** Full-size photos of the open letter, fetched once per letter and in position order. */
function detailImages(item) {
  if (imgs?.id !== item.id) {
    dropImages();
    const mine = { id: item.id, dead: false, urls: [] };
    mine.urls = item.attachments.map((a) => blobUrl(`/api/feedback/${item.id}/attachments/${a.position}`)
      .then((u) => { if (mine.dead && u) { URL.revokeObjectURL(u); return null; } return u; }));
    imgs = mine;
  }
  return imgs.urls;
}

const boxName = (slug) => projects.find((p) => p.slug === slug)?.name || slug;
const visible = () => items.filter((i) => matchesSearch(i, query));
const pill = (status) => el("span", `pill ${status}`, STATUS_LABEL[status] || status);

/* ---------- chrome: tabs, chips, mailboxes ---------- */

function renderFilters() {
  $("tabs").replaceChildren(...TABS.map((t) => {
    const b = el("button", "", t.label);
    b.type = "button"; b.setAttribute("aria-pressed", String(t.key === tab));
    b.addEventListener("click", () => { tab = t.key; renderFilters(); loadList(); });
    return b;
  }));
  $("kinds").replaceChildren(...KINDS.map((k) => {
    const b = el("button", "", KIND_LABEL[k]);
    b.type = "button"; b.setAttribute("aria-pressed", String(k === kind));
    b.addEventListener("click", () => { kind = kind === k ? "" : k; renderFilters(); loadList(); });
    return b;
  }));
}

function renderBoxes() {
  const row = (slug, label, n, ic) => {
    const b = el("button");
    b.type = "button";
    b.setAttribute("aria-current", String(project === slug));
    if (ic) b.append(icon(ic));
    b.append(el("span", "nm", label), el("span", n ? "count" : "count zero", n ? `${n}${unread.more ? "+" : ""}` : "0"));
    b.addEventListener("click", () => pickMailbox(slug));
    const li = el("li"); li.append(b);
    return li;
  };
  $("boxes").replaceChildren(row("", "All mail", unread.total, "mail"), ...projects.map((p) => row(p.slug, p.name, unread.by[p.slug] || 0)));
  const sel = $("f-project");
  sel.replaceChildren(new Option(`All mail (${unread.total})`, ""), ...projects.map((p) => new Option(`${p.name} (${unread.by[p.slug] || 0})`, p.slug)));
  sel.value = project;
  document.title = unread.total ? `(${unread.total}${unread.more ? "+" : ""}) Postbox` : "Postbox";
}

function pickMailbox(slug) {
  project = slug; renderBoxes(); loadList();
  if (hashId()) closeLetter();
}

async function loadProjects() {
  projects = await (await api("/api/projects")).json();
  renderBoxes();
}

async function loadCounts() {
  try {
    const r = await (await api(`/api/feedback?${listQuery({ status: "new", limit: 200 })}`)).json();
    unread = { ...unreadCounts(r.items), more: !!r.next_cursor };
    renderBoxes();
  } catch {}
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
  $("list").replaceChildren(...Array.from({ length: 6 }, () => { const s = el("li", "skel"); s.setAttribute("aria-hidden", "true"); s.append(el("i"), (() => { const d = el("div"); d.append(el("b"), el("b")); return d; })()); return s; }));
}

async function loadList(more = false) {
  const seq = ++loadSeq;
  const status = tabStatus(tab);
  const streams = statusStreams(status);
  if (!more) { dropThumbs(); items = []; cursors = {}; setMsg(""); skeletons(); $("more").hidden = true; }
  $("list").setAttribute("aria-busy", "true");
  try {
    const pages = await Promise.all(streams
      .filter((s) => !more || cursors[s])
      .map(async (s) => {
        const r = await (await api(`/api/feedback?${listQuery({ project, kind, status: s, cursor: more ? cursors[s] : "" })}`)).json();
        return [s, r];
      }));
    if (seq !== loadSeq) return;
    for (const [s, r] of pages) cursors[s] = r.next_cursor;
    items = mergeItems(items, ...pages.map(([, r]) => r.items));
    $("more").hidden = !streams.some((s) => cursors[s]);
    renderList();
  } catch (e) {
    if (e instanceof AuthError || seq !== loadSeq) return;
    $("list").replaceChildren();
    setMsg("Could not load letters.", `${e.message}. Check your connection, then try again.`, true);
  } finally { if (seq === loadSeq) $("list").removeAttribute("aria-busy"); }
}

function emptyCopy() {
  if (query && items.length) return ["No loaded letter matches.", "Search covers the letters loaded in this view. Clear the search, or press Load more."];
  if (tab === "open") return ["All caught up.", "No unread or in-progress letters here. When someone sends feedback, it lands in this mailbox."];
  return ["No letters here.", "When someone sends feedback, it lands in this mailbox."];
}

function renderList() {
  const ul = $("list");
  const rows = visible();
  seen?.disconnect();
  if (!rows.length) { ul.replaceChildren(); setMsg(...emptyCopy()); return; }
  setMsg("");
  seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      seen.unobserve(e.target);
      const item = items.find((i) => i.id === Number(e.target.dataset.id));
      const path = item && thumbPath(item);
      if (!path) continue;
      if (!thumbs.has(path)) thumbs.set(path, blobUrl(path));
      thumbs.get(path).then((u) => { const box = e.target.querySelector(".thumbbox"); if (u && box) box.replaceChildren(Object.assign(el("img", "thumb"), { src: u, alt: "" }), ...box.querySelectorAll(".badge")); });
    }
  });
  ul.replaceChildren(...rows.map((i) => {
    const li = el("li", i.status === "new" ? "unread" : "");
    li.dataset.id = i.id; li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i.id === selected));
    if (i.attachment_count) {
      const box = el("div", "thumbbox");
      box.append(el("div", "thumb"));
      if (moreBadge(i)) box.append(el("span", "badge", moreBadge(i)));
      li.append(box);
    } else { const n = el("div", "noshot"); n.append(icon("mail")); li.append(n); }
    const body = el("div");
    const r1 = el("div", "r1");
    r1.append(el("span", "first", firstLine(i.text) || "(no text)"), el("span", "when", relativeTime(i.created_at)));
    const r2 = el("div", "r2");
    r2.append(el("span", "box", boxName(i.project)), el("span", "kind", KIND_LABEL[i.kind] || i.kind), pill(i.status));
    const meta = [i.screen, [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" "), i.platform].filter(Boolean).join(" · ");
    body.append(r1, r2, el("div", "r3", meta));
    li.append(body);
    li.addEventListener("click", () => { location.hash = `#/feedback/${i.id}`; });
    if (i.attachment_count) seen.observe(li); // loads only when the row scrolls into view
    return li;
  }));
}

function select(id) {
  selected = id;
  for (const li of $("list").children) li.setAttribute("aria-selected", String(Number(li.dataset.id) === id));
  $("list").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

/* ---------- reading pane ---------- */

const hashId = () => Number(/^#\/feedback\/(\d+)$/.exec(location.hash)?.[1]) || null;

function placeholder() {
  const d = el("div", "empty");
  d.append(icon("mail"), el("strong", "", "Select a letter"), el("span", "", "Pick one from the list to read it. Press ? for keyboard shortcuts."));
  return d;
}

async function route() {
  const id = hashId();
  const pane = $("detail");
  $("shell").classList.toggle("open", !!id);
  if (!id) { detail = null; dropImages(); pane.replaceChildren(placeholder()); return; }
  select(id);
  if (imgs && imgs.id !== id) dropImages();
  const sk = el("div", "skeleton-detail"); sk.setAttribute("aria-busy", "true");
  sk.append(el("i"), el("i"), el("i"));
  pane.replaceChildren(sk);
  try {
    const d = await (await api(`/api/feedback/${id}`)).json();
    if (hashId() !== id) return;
    detail = d;
    renderDetail();
    pane.scrollTop = 0;
  } catch (e) {
    if (e instanceof AuthError) return;
    const m = el("div", "empty");
    m.append(el("strong", "", e.message.startsWith("404") ? "This letter no longer exists." : "Could not open this letter."),
      el("span", "", e.message.startsWith("404") ? "It may have been cleaned up. Go back to the list." : `${e.message}. Check your connection, then press Esc and try again.`));
    pane.replaceChildren(m);
  }
}

function renderDetail() {
  const i = detail;
  const pane = $("detail");
  const draft = $("note")?.dataset.id === String(i.id) ? $("note").value : null;
  const back = el("button", "back");
  back.type = "button"; back.append(icon("back"), el("span", "", "Letters"));
  back.addEventListener("click", closeLetter);
  const copy = el("button", "primary");
  copy.type = "button"; copy.append(icon("copy"), el("span", "", "Copy for agent"));
  const copyText = copy.lastChild;
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(brief(i)); copyText.textContent = "Copied"; }
    catch { copyText.textContent = "Copy failed - clipboard blocked"; }
    setTimeout(() => { copyText.textContent = "Copy for agent"; }, 2000);
  });
  const head = el("div", "l-head");
  head.append(back, el("h2", "", `Letter #${i.id} · ${boxName(i.project)}`), pill(i.status), el("span", "spacer"), copy);

  const bar = el("div", "status-bar");
  bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Set status");
  for (const [n, s] of STATUSES.entries()) {
    const b = el("button");
    b.type = "button";
    b.append(el("kbd", "", String(n + 1)), document.createTextNode(STATUS_LABEL[s]));
    b.setAttribute("aria-pressed", String(i.status === s));
    b.addEventListener("click", () => setStatus(s));
    bar.append(b);
  }

  const shots = el("div", "shots");
  shots.setAttribute("aria-label", "Photos");
  if (i.attachments?.length) {
    detailImages(i).forEach((p, n) => {
      const slot = el("div", "ph", `Photo ${n + 1}`);
      shots.append(slot);
      p.then((u) => {
        if (detail !== i || !slot.isConnected) return;
        if (!u) { slot.className = "ph bad"; slot.textContent = `Photo ${n + 1} could not be loaded`; return; }
        const b = el("button");
        b.type = "button"; b.title = "Open photo"; b.setAttribute("aria-label", `Open photo ${n + 1} of ${i.attachments.length}`);
        b.append(Object.assign(el("img"), { src: u, alt: "" }));
        b.addEventListener("click", () => openLightbox(n));
        slot.replaceWith(b);
      });
    });
  }

  const dl = el("dl", "ctx");
  const build = [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ");
  const fields = [["Screen", i.screen], ["Build", build], ["Platform", i.platform], ["Device", i.device], ["OS", i.os], ["Locale", i.locale], ["URL", i.url],
    ["Created", new Date(i.created_at).toLocaleString()], ["Updated", new Date(i.updated_at).toLocaleString()]];
  for (const [k, v] of fields) if (v) dl.append(el("dt", "", k), el("dd", "", v));

  const label = el("label", "note-label", "Note"); label.htmlFor = "note";
  const note = el("textarea");
  note.id = "note"; note.dataset.id = i.id; note.value = draft ?? (i.note || ""); note.maxLength = 4000;
  note.placeholder = "Private note, visible only here";
  const save = el("button");
  save.type = "button"; save.textContent = "Save note";
  save.addEventListener("click", async () => {
    save.textContent = "Saving...";
    try { await patch({ note: note.value }); save.textContent = "Saved"; }
    catch (e) { if (!(e instanceof AuthError)) save.textContent = `Save failed (${e.message}), try again`; }
  });
  note.addEventListener("input", () => { save.textContent = "Save note"; });
  const actions = el("div", "note-actions"); actions.append(save);

  const wrap = el("article", "letter");
  wrap.append(head, bar, ...(i.attachments?.length ? [shots] : []), el("p", "l-text", i.text), dl, label, note, actions);
  pane.replaceChildren(wrap);
}

async function patch(body) {
  const updated = await (await api(`/api/feedback/${detail.id}`, { method: "PATCH", body: JSON.stringify(body) })).json();
  Object.assign(detail, updated);
  const k = items.findIndex((x) => x.id === updated.id);
  if (k >= 0) Object.assign(items[k], updated);
  return updated;
}

async function setStatus(status) {
  const id = detail?.id ?? selected;
  if (!id) return;
  try {
    if (!detail || detail.id !== id) detail = await (await api(`/api/feedback/${id}`)).json();
    await patch({ status });
    renderList(); if (hashId()) renderDetail();
    loadCounts();
  } catch (e) { if (!(e instanceof AuthError)) setMsg("Could not change the status.", `${e.message}. Try again.`); }
}

function closeLetter() { history.replaceState(null, "", location.pathname + location.search); route(); }

/* ---------- lightbox ---------- */

async function showPhoto(n) {
  const urls = imgs?.urls || [];
  lbIndex = stepIndex(n, urls.length, 0);
  const u = await urls[lbIndex];
  if (!$("lightbox").open) return;
  $("lb-img").src = u || "";
  $("lb-img").alt = `Photo ${lbIndex + 1} of ${urls.length}`;
  $("lb-count").textContent = `${lbIndex + 1} / ${urls.length}`;
  $("lb-prev").disabled = lbIndex === 0; $("lb-next").disabled = lbIndex === urls.length - 1;
}
function openLightbox(n) { $("lightbox").showModal(); showPhoto(n); }

/* ---------- theme ---------- */

const dark = () => ($("theme").dataset.mode || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
function paintTheme() {
  const mode = document.documentElement.dataset.theme || "";
  $("theme").dataset.mode = mode;
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
  const rows = visible();
  if (!rows.length) return;
  const idx = rows.findIndex((i) => i.id === selected);
  const n = rows[Math.min(rows.length - 1, Math.max(0, idx < 0 ? 0 : idx + dir))];
  select(n.id);
  if (hashId()) { history.replaceState(null, "", `#/feedback/${n.id}`); route(); }
}

document.addEventListener("keydown", (e) => {
  if ($("app").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("lightbox").open) {
    if (e.key === "ArrowLeft") { e.preventDefault(); showPhoto(lbIndex - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); showPhoto(lbIndex + 1); }
    return; // Esc closes the dialog natively
  }
  if ($("keys").open) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  if (e.key === "Escape") { if (typing) t.blur(); else if (hashId()) closeLetter(); return; }
  if (typing) return;
  const r = shortcutAction(e.key, pendingG);
  pendingG = r.pendingG; clearTimeout(gTimer);
  if (pendingG) gTimer = setTimeout(() => { pendingG = false; }, 1500);
  const a = r.action;
  if (!a) return;
  if (a === "open" && /^(BUTTON|A)$/.test(t.tagName)) return; // let a focused control keep its own Enter
  e.preventDefault();
  if (a === "next") move(1);
  else if (a === "prev") move(-1);
  else if (a === "open") { if (selected) location.hash = `#/feedback/${selected}`; }
  else if (a === "search") $("q").focus();
  else if (a === "help") $("keys").showModal();
  else if (a === "allMail") pickMailbox("");
  else if (a.startsWith("status:")) setStatus(a.slice(7));
});

/* ---------- boot ---------- */

async function start() {
  $("login").hidden = true; $("app").hidden = false;
  renderFilters(); route();
  try { await loadProjects(); } catch (e) { if (e instanceof AuthError) return; setMsg("Could not reach Postbox.", `${e.message}. Reload to retry.`); }
  loadCounts();
  await loadList();
  if (hashId()) route();
}

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = cleanToken($("token").value);
  if (!token) return;
  store.set(token); $("login-error").hidden = true;
  start();
});
$("signout").addEventListener("click", () => signOut());
$("brand").addEventListener("click", (e) => { e.preventDefault(); pickMailbox(""); });
$("f-project").addEventListener("change", (e) => pickMailbox(e.target.value));
$("q").addEventListener("input", (e) => { query = e.target.value; if (items.length) renderList(); });
$("more").addEventListener("click", () => loadList(true));
$("help").addEventListener("click", () => $("keys").showModal());
$("keys-close").addEventListener("click", () => $("keys").close());
$("lb-close").addEventListener("click", () => $("lightbox").close());
$("lb-prev").addEventListener("click", () => showPhoto(lbIndex - 1));
$("lb-next").addEventListener("click", () => showPhoto(lbIndex + 1));
$("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) $("lightbox").close(); });
window.addEventListener("hashchange", route);
paintTheme();

if (token) start(); else { $("login").hidden = false; $("token").focus(); }
