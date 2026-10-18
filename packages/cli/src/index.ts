import { parseArgs } from "node:util";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Deps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  configPath: string;
  /** Pre-rename config (~/.config/fh/config.json), copied once to configPath when that is missing. */
  legacyConfigPath?: string;
  tmp: string;
};

export const realDeps = (): Deps => ({
  fetch,
  env: process.env,
  out: (l) => console.log(l),
  configPath: join(homedir(), ".config", "postbox", "config.json"),
  legacyConfigPath: join(homedir(), ".config", "fh", "config.json"),
  tmp: tmpdir(),
});

const STATUSES = ["new", "ready", "doing", "done", "wont_fix"]; // duplicate is set by the owner in the dashboard
const PRIORITY = ["urgent", "high", "normal", "low"];
const USAGE = `usage:
  postbox login <url> <token>
  postbox queue [--project slug] [--json]             letters in Ready, highest priority then oldest
  postbox claim <id> [--json]                         Ready -> In progress, prints the brief
  postbox brief <id...> [--json]                      brief for several letters (duplicates folded in, photos downloaded)
  postbox show <id> [--json]                          one brief (--json: the raw letter)
  postbox list [--project slug] [--status a,b] [--kind k] [--priority 0-3|none] [--label l] [--screen s] [--source app|web] [--q text] [--sort new|old|priority] [--json]
  postbox add --project slug --text "..." [--kind bug|idea|other] [--screen s] [--photo path ...] [--json]
  postbox status <id> <new|ready|doing|done|wont_fix>
  postbox done <id> --note "..."
  postbox note <id> "..."
  postbox project add <slug> <name>`;

function migrateConfig(d: Deps) {
  if (!d.legacyConfigPath || existsSync(d.configPath) || !existsSync(d.legacyConfigPath)) return;
  mkdirSync(dirname(d.configPath), { recursive: true });
  copyFileSync(d.legacyConfigPath, d.configPath);
  chmodSync(d.configPath, 0o600);
}

function config(d: Deps) {
  migrateConfig(d);
  let file: { url?: string; token?: string } = {};
  try {
    file = JSON.parse(readFileSync(d.configPath, "utf8"));
  } catch {}
  const url = d.env.POSTBOX_URL ?? file.url;
  const token = d.env.POSTBOX_TOKEN ?? file.token;
  if (!url || !token) throw new Error("not configured: set POSTBOX_URL and POSTBOX_TOKEN or run `postbox login <url> <token>`");
  return { url: url.replace(/\/+$/, ""), token };
}

async function api(d: Deps, path: string, init: RequestInit = {}) {
  const c = config(d);
  const res = await d.fetch(c.url + path, {
    ...init,
    headers: { authorization: `Bearer ${c.token}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {}
    throw new Error(`${res.status} ${msg}`);
  }
  return res;
}

const patch = async (d: Deps, id: string, body: object) =>
  (await api(d, `/api/feedback/${id}`, { method: "PATCH", body: JSON.stringify(body) })).json() as Promise<Item>;

export type Attachment = { position: number; kind: string; bytes: number | null; content_type: string };
export type Item = {
  id: number; project: string; kind: string; text: string; status: string; note: string | null;
  priority?: number | null; labels?: string[]; duplicate_of?: number | null; source?: string;
  screen: string | null; build: string | null; app_version: string | null; platform: string | null;
  device: string | null; os: string | null; locale?: string | null; url: string | null; created_at: string;
  attachment_count?: number; attachments?: Attachment[]; duplicates?: { id: number; text: string }[];
};
/** `postbox brief --json` / `claim --json`: the letter, its photo paths and the full duplicates with their paths. */
export type Brief = Omit<Item, "duplicates"> & { photos: string[]; duplicates: (Omit<Item, "duplicates"> & { photos: string[] })[] };

const prio = (p?: number | null) => (p == null ? null : `${p} (${PRIORITY[p]})`);
const row = (k: string, v: unknown) => (v == null || v === "" ? [] : [`- ${k}: ${v}`]);

function one(i: Omit<Item, "duplicates">, paths: string[], heading: string): string[] {
  return [
    heading, "",
    ...row("mailbox", i.project), ...row("kind", i.kind), ...row("priority", prio(i.priority)), ...row("labels", i.labels?.join(", ")), ...row("status", i.status),
    ...row("screen", i.screen), ...row("build", [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ")),
    ...row("platform", i.platform), ...row("device", i.device), ...row("os", i.os), ...row("locale", i.locale), ...row("url", i.url),
    ...row("source", i.source), ...row("created", i.created_at), ...paths.map((p, n) => `- image ${n + 1}: ${p}`),
    "", "## Text", "", i.text,
    ...(i.note ? ["", "## Decision for the agent", "", i.note] : []),
  ];
}

/** One Markdown document per letter; duplicates (more reports of the same problem) follow as evidence. */
export function brief(i: Item | Brief, paths: string[] = (i as Brief).photos ?? []): string {
  const dups = ((i as Brief).duplicates ?? []).filter((x): x is Brief["duplicates"][number] => "photos" in x);
  return [
    ...one(i, paths, `# Feedback #${i.id}`),
    ...(dups.length ? ["", `## Duplicates (${dups.length})`, "", "More reports of the same problem; read them as extra evidence.", ""] : []),
    ...dups.flatMap((x) => [...one(x, x.photos, `### Duplicate #${x.id}`), ""]),
  ].join("\n").trimEnd();
}

const ext = (t: string) => (t === "image/png" ? "png" : "jpg");
const fetchItem = async (d: Deps, id: string | number) => (await (await api(d, `/api/feedback/${id}`)).json()) as Item;

/** Every attachment goes to the temp folder (in parallel); paths come back in display order. */
async function download(d: Deps, item: Item): Promise<string[]> {
  return Promise.all((item.attachments ?? []).map(async (at) => {
    const res = await api(d, `/api/feedback/${item.id}/attachments/${at.position}`);
    const path = join(d.tmp, `postbox-${item.id}-${at.position}.${ext(at.content_type)}`);
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    return path;
  }));
}

async function fullBrief(d: Deps, id: string | number): Promise<Brief> {
  const item = await fetchItem(d, id);
  const dupItems = await Promise.all((item.duplicates ?? []).map((x) => fetchItem(d, x.id)));
  const [photos, ...dupPhotos] = await Promise.all([item, ...dupItems].map((x) => download(d, x)));
  return { ...item, photos, duplicates: dupItems.map((x, n) => ({ ...x, duplicates: undefined, photos: dupPhotos[n] })) } as Brief;
}

const sniff = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png" : null);

/** Client-side checks against GET /api/limits (public) before anything is uploaded. */
async function readPhotos(d: Deps, paths: string[]) {
  if (!paths.length) return [];
  const lim = (await (await d.fetch(config(d).url + "/api/limits")).json()) as { max_attachments: number; max_image_bytes: number; max_total_bytes: number };
  if (paths.length > lim.max_attachments) throw new Error(`at most ${lim.max_attachments} photos`);
  let total = 0;
  const files = paths.map((p) => {
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch {
      throw new Error(`cannot read ${p}`);
    }
    if (!sniff(buf)) throw new Error(`${p}: only jpeg and png photos`);
    if (buf.length > lim.max_image_bytes) throw new Error(`${p}: larger than ${lim.max_image_bytes} bytes`);
    total += buf.length;
    return { buf, type: sniff(buf)!, name: p.split("/").pop()! };
  });
  if (total > lim.max_total_bytes) throw new Error(`photos together are larger than ${lim.max_total_bytes} bytes`);
  return files;
}

export async function run(argv: string[], d: Deps = realDeps()): Promise<void> {
  const { values, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" }, status: { type: "string" }, kind: { type: "string" },
      json: { type: "boolean" }, note: { type: "string" }, priority: { type: "string" }, label: { type: "string" },
      screen: { type: "string" }, source: { type: "string" }, q: { type: "string" }, sort: { type: "string" }, text: { type: "string" },
      photo: { type: "string", multiple: true },
    },
  });
  const [cmd, a, b] = p;
  const asJson = (v: unknown) => d.out(JSON.stringify(v, null, 2));

  if (cmd === "login" && a && b) {
    mkdirSync(dirname(d.configPath), { recursive: true });
    writeFileSync(d.configPath, JSON.stringify({ url: a, token: b }) + "\n", { mode: 0o600 });
    chmodSync(d.configPath, 0o600);
    return d.out(`saved ${d.configPath}`);
  }
  if (cmd === "list" || cmd === "queue") {
    const q = new URLSearchParams({ limit: "200" });
    for (const k of ["project", "status", "kind", "priority", "label", "screen", "source", "q", "sort"] as const) if (values[k] && !(cmd === "queue" && (k === "status" || k === "sort"))) q.set(k, values[k]!);
    if (cmd === "queue") { q.set("status", "ready"); q.set("sort", "priority"); }
    const { items } = (await (await api(d, `/api/feedback?${q}`)).json()) as { items: Item[] };
    if (values.json) return asJson(items);
    if (!items.length) return d.out(cmd === "queue" ? "queue is empty" : "no feedback");
    for (const i of items) {
      const text = i.text.replace(/\s+/g, " ");
      d.out([String(i.id).padStart(4), i.status.padEnd(8), (i.priority == null ? "-" : PRIORITY[i.priority]).padEnd(6), i.kind.padEnd(5), i.project.padEnd(12), (i.screen ?? "-").padEnd(14), text.length > 60 ? text.slice(0, 59) + "~" : text].join("  "));
    }
    return;
  }
  if (cmd === "show" && a && values.json) return asJson(await fetchItem(d, a));
  if ((cmd === "show" || cmd === "brief" || cmd === "claim") && a) {
    const id = a;
    if (cmd === "claim") {
      const cur = await fetchItem(d, id);
      if (cur.status !== "ready") throw new Error(`#${id} is not ready (status: ${cur.status}); only the owner sets Ready`);
      await patch(d, id, { status: "doing" });
    }
    const briefs = await Promise.all((cmd === "brief" ? p.slice(1) : [id]).map((x) => fullBrief(d, x)));
    if (values.json) return asJson(cmd === "brief" ? briefs : briefs[0]);
    return d.out(briefs.map((x) => brief(x)).join("\n\n---\n\n"));
  }
  if (cmd === "add") {
    if (!values.project || !values.text?.trim()) throw new Error('postbox add needs --project slug --text "..."');
    const files = await readPhotos(d, values.photo ?? []);
    const form = new FormData();
    form.set("meta", JSON.stringify({ project: values.project, text: values.text, ...(values.kind ? { kind: values.kind } : {}), ...(values.screen ? { screen: values.screen } : {}) }));
    for (const f of files) form.append("photo", new File([new Uint8Array(f.buf)], f.name, { type: f.type }));
    const r = (await (await api(d, "/api/feedback", { method: "POST", body: form })).json()) as { id: number };
    return values.json ? asJson(r) : d.out(`#${r.id} added`);
  }
  if (cmd === "status" && a && b) {
    if (!STATUSES.includes(b)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
    return d.out(`#${a} -> ${(await patch(d, a, { status: b })).status}`);
  }
  if (cmd === "done" && a) {
    if (!values.note) throw new Error('postbox done needs --note "..."');
    await patch(d, a, { status: "done", note: values.note });
    return d.out(`#${a} -> done`);
  }
  if (cmd === "note" && a && b) {
    await patch(d, a, { note: b });
    return d.out(`#${a} note saved`);
  }
  if (cmd === "project" && a === "add" && p[2] && p[3]) {
    const r = (await (await api(d, "/api/projects", { method: "POST", body: JSON.stringify({ slug: p[2], name: p[3] }) })).json()) as { public_key: string };
    return d.out(r.public_key);
  }
  throw new Error(USAGE);
}
