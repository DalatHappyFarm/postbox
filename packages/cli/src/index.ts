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

const STATUSES = ["new", "doing", "done", "wont_fix"];
const USAGE = `usage:
  postbox login <url> <token>
  postbox list [--project slug] [--status s] [--kind k] [--json]
  postbox show <id> [--json]   (downloads every attachment)
  postbox status <id> <new|doing|done|wont_fix>
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
    headers: { authorization: `Bearer ${c.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
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

type Item = {
  id: number; project: string; kind: string; text: string; status: string; note: string | null;
  screen: string | null; build: string | null; app_version: string | null; platform: string | null;
  device: string | null; os: string | null; url: string | null; created_at: string;
  attachment_count?: number; attachments?: { position: number; kind: string; bytes: number | null; content_type: string }[];
};

export function brief(i: Item, paths: string[] = []): string {
  const row = (k: string, v: unknown) => (v == null || v === "" ? [] : [`- ${k}: ${v}`]);
  return [
    `# Feedback #${i.id}`,
    "",
    ...row("project", i.project), ...row("kind", i.kind), ...row("status", i.status), ...row("screen", i.screen),
    ...row("build", [i.app_version, i.build && `(${i.build})`].filter(Boolean).join(" ")),
    ...row("platform", i.platform), ...row("device", i.device), ...row("os", i.os), ...row("url", i.url),
    ...row("created", i.created_at), ...paths.map((p, n) => `- image ${n + 1}: ${p}`),
    "",
    "## Text",
    "",
    i.text,
    ...(i.note ? ["", "## Note", "", i.note] : []),
  ].join("\n");
}

export async function run(argv: string[], d: Deps = realDeps()): Promise<void> {
  const { values, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" }, status: { type: "string" }, kind: { type: "string" },
      json: { type: "boolean" }, note: { type: "string" },
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
  if (cmd === "list") {
    const q = new URLSearchParams({ limit: "200" });
    for (const k of ["project", "status", "kind"] as const) if (values[k]) q.set(k, values[k]!);
    const { items } = (await (await api(d, `/api/feedback?${q}`)).json()) as { items: Item[] };
    if (values.json) return asJson(items);
    if (!items.length) return d.out("no feedback");
    for (const i of items) {
      const text = i.text.replace(/\s+/g, " ");
      d.out([String(i.id).padStart(4), i.status.padEnd(8), i.kind.padEnd(5), i.project.padEnd(12), (i.screen ?? "-").padEnd(14), text.length > 60 ? text.slice(0, 59) + "~" : text].join("  "));
    }
    return;
  }
  if (cmd === "show" && a) {
    const item = (await (await api(d, `/api/feedback/${a}`)).json()) as Item;
    if (values.json) return asJson(item);
    // Every attachment goes to the temp folder (in parallel); the brief lists the paths in display order.
    const paths = await Promise.all((item.attachments ?? []).map(async (at) => {
      const res = await api(d, `/api/feedback/${a}/attachments/${at.position}`);
      const path = join(d.tmp, `postbox-${item.id}-${at.position}.${at.content_type === "image/png" ? "png" : "jpg"}`);
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      return path;
    }));
    return d.out(brief(item, paths));
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
