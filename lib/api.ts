import { neon } from "@neondatabase/serverless";
import { stripJpeg } from "./jpeg.ts";
import { readLimits, type Limits } from "./limits.ts";

export type Row = Record<string, any>;
export type Sql = (s: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
export type R2 = {
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string, opts?: { onlyIf?: Headers }): Promise<{ body?: ReadableStream | null; httpEtag?: string } | null>;
  delete(keys: string | string[]): Promise<unknown>;
};
export type Env = { DATABASE_URL?: string; ADMIN_TOKEN?: string; SHOTS?: R2 } & { [K in keyof Limits]?: string | number };

const KINDS = ["bug", "idea", "other"];
const STATUSES = ["new", "ready", "doing", "done", "wont_fix", "duplicate"];
const SOURCES = ["app", "web"];
const LABEL = /^[a-z0-9-]{1,32}$/;
const PLATFORMS = ["ios", "android", "web"];
const BODY_SLACK = 64 * 1024; // meta fields and multipart framing on top of the images
const IMAGE_TYPES = ["image/jpeg", "image/png"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-project-key, x-device-id",
  "access-control-max-age": "86400",
};

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status: number, error: string, headers: HeadersInit = {}) => json({ error }, status, headers);

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Constant time: compare fixed-length digests, no early exit.
async function tokenOk(given: string, expected: string) {
  const a = await sha256(given);
  const b = await sha256(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function handle(req: Request, env: Env, sql: Sql): Promise<Response> {
  const { pathname } = new URL(req.url);
  const seg = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;
  const L = readLimits(env);

  if (seg[0] === "limits" && seg.length === 1 && m === "GET") {
    return json(
      { max_attachments: L.MAX_ATTACHMENTS, max_image_bytes: L.MAX_IMAGE_BYTES, max_total_bytes: L.MAX_TOTAL_BYTES, max_text: L.MAX_TEXT, image_types: IMAGE_TYPES },
      200,
      { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
    );
  }
  if (seg[0] === "submit" && seg.length === 1) {
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (m !== "POST") return fail(405, "method not allowed", CORS);
    return submit(req, env, sql, L);
  }

  if (!env.ADMIN_TOKEN) return fail(500, "misconfigured");
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer || !(await tokenOk(bearer, env.ADMIN_TOKEN))) return fail(401, "unauthorized");

  if (seg[0] === "projects" && seg.length === 1) {
    if (m === "GET") return projects(sql);
    if (m === "POST") return createProject(req, sql);
  }
  if (seg[0] === "feedback") {
    if (seg.length === 1 && m === "GET") return list(new URL(req.url), sql);
    if (seg.length === 1 && m === "POST") return addLetter(req, env, sql, L);
    if (seg.length === 2 && seg[1] === "bulk" && m === "POST") return bulk(req, sql);
    const id = /^\d{1,9}$/.test(seg[1] ?? "") ? Number(seg[1]) : null;
    if (seg.length >= 2 && id === null) return fail(404, "not found");
    if (seg.length === 2 && m === "GET") return one(id!, sql);
    if (seg.length === 2 && m === "PATCH") return patch(id!, req, sql, L);
    if (m === "GET" && seg.length === 3 && seg[2] === "screenshot") return attachment(id!, 0, req, env, sql);
    if (m === "GET" && seg.length === 3 && seg[2] === "thumb") return thumb(id!, req, env, sql);
    if (m === "GET" && seg.length === 4 && seg[2] === "attachments" && /^\d{1,4}$/.test(seg[3])) return attachment(id!, Number(seg[3]), req, env, sql);
  }
  return fail(404, "not found");
}

const str = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null ? null : typeof v === "string" && v.length <= max ? v : undefined;

const sniff = (b: Uint8Array): { ext: string; mime: string } | null =>
  b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? { ext: "jpg", mime: "image/jpeg" }
  : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) ? { ext: "png", mime: "image/png" }
  : null;

type Img = { kind: "screenshot" | "photo"; bytes: Uint8Array; ext: string; mime: string };

/** Type from magic bytes only; JPEG metadata (EXIF, GPS, ...) is stripped. Returns a status and message on failure. */
function prepare(raw: Uint8Array, kind: Img["kind"]): Img | [number, string] {
  const t = sniff(raw);
  if (!t) return [415, "images must be jpeg or png"];
  if (t.mime === "image/png") return { kind, bytes: raw, ...t };
  try {
    return { kind, bytes: stripJpeg(raw), ...t };
  } catch {
    return [415, "invalid jpeg"];
  }
}

const META_FIELDS = [["screen", 200], ["app_version", 200], ["build", 200], ["device", 200], ["os", 200], ["locale", 200], ["url", 2000], ["device_id", 200]] as const;

async function submit(req: Request, env: Env, sql: Sql, L: Limits): Promise<Response> {
  const bad = (status: number, error: string) => fail(status, error, CORS);
  // 1. key and rate limit first: a rejected caller costs no body read.
  const key = req.headers.get("x-project-key");
  if (!key) return bad(401, "missing project key");
  const [project] = await sql`select id::int as id, slug from projects where public_key = ${key}`;
  if (!project) return bad(401, "invalid project key");

  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  // ponytail: plain sha-256 of ip + device id, no secret salt; the hash only groups submits, add a salt if it is ever shown to anyone.
  // The device id comes from a header so the check needs no body; without it the limit is per ip.
  const reporter = hex(await sha256(`${ip}|${(req.headers.get("x-device-id") ?? "").slice(0, 200)}`));
  const [{ per_device }] = await sql`select count(*)::int as per_device from submit_log where reporter_hash = ${reporter} and created_at > now() - interval '1 hour'`;
  const [{ per_project }] = await sql`select count(*)::int as per_project from submit_log where project_id = ${project.id} and created_at > now() - interval '1 hour'`;
  if (per_device >= L.RATE_PER_DEVICE_HOUR || per_project >= L.RATE_PER_PROJECT_HOUR) return bad(429, "rate limit exceeded");
  // ponytail: count-then-insert is not atomic, so a burst can overshoot the limit slightly; fine for a single-owner test tool.
  // Logged before the body is read, so malformed floods count too.
  await sql`insert into submit_log (project_id, reporter_hash) values (${project.id}, ${reporter})`;

  const p = await parseLetter(req, env, L, bad);
  if (p instanceof Response) return p;

  // Retention promised to users: handled items go 180 days after they were closed (images expire in R2 after 90 days).
  // ponytail: runs on submit, so a project with no new feedback keeps old rows longer; move to a cron trigger if that matters.
  await sql`delete from submit_log where created_at < now() - interval '1 day'`;
  await sql`delete from feedback where status in ('done', 'wont_fix', 'duplicate') and updated_at < now() - interval '180 days'`;

  const id = await saveLetter(env, sql, project, p, "app", reporter);
  return id === null ? bad(500, "could not store images") : json({ id }, 201, CORS);
}

type Letter = { b: Row; text: string; kind: string; f: Row; imgs: Img[]; thumb: Img | null };

/** Steps 2 to 5 shared by the public submit and the admin add: length guard, body, field checks, sizes, magic bytes, stripping. */
async function parseLetter(req: Request, env: Env, L: Limits, bad: (status: number, error: string) => Response): Promise<Letter | Response> {
  // 2. Content-Length guard before parsing.
  const multipart = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
  const cl = req.headers.get("content-length");
  if (cl === null || !/^\d{1,15}$/.test(cl)) return bad(411, "content-length required");
  const maxBody = BODY_SLACK + (multipart ? L.MAX_TOTAL_BYTES + L.MAX_THUMB_BYTES : Math.ceil((L.MAX_IMAGE_BYTES * 4) / 3));
  if (Number(cl) > maxBody) return bad(413, "body too large");

  let b: Row;
  const files: { kind: Img["kind"]; blob: Blob }[] = [];
  let thumbBlob: Blob | null = null;
  let jsonShot: string | null = null;
  if (multipart) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return bad(400, "invalid multipart body");
    }
    const meta = form.get("meta");
    if (typeof meta !== "string") return bad(400, "meta is required");
    try {
      b = JSON.parse(meta);
    } catch {
      return bad(400, "invalid json");
    }
    const shot = form.get("screenshot");
    const photos = form.getAll("photo");
    const th = form.get("thumb");
    if ([shot, th, ...photos].some((v) => typeof v === "string")) return bad(400, "image fields must be files");
    if (shot) files.push({ kind: "screenshot", blob: shot as Blob });
    for (const p of photos) files.push({ kind: "photo", blob: p as Blob });
    thumbBlob = (th as Blob | null) ?? null;
  } else {
    try {
      b = JSON.parse(await req.text());
    } catch {
      return bad(400, "invalid json");
    }
    if (b && typeof b === "object" && b.screenshot != null) {
      if (typeof b.screenshot !== "string") return bad(400, "invalid screenshot");
      jsonShot = b.screenshot;
    }
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad(400, "invalid json");

  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return bad(400, "text is required");
  if (text.length > L.MAX_TEXT) return bad(413, "text too long");
  const kind = b.kind ?? "other";
  if (!KINDS.includes(kind)) return bad(400, "invalid kind");
  if (b.platform != null && !PLATFORMS.includes(b.platform)) return bad(400, "invalid platform");
  const f: Row = {};
  for (const [k, max] of META_FIELDS) {
    const v = str(b[k], max);
    if (v === undefined) return bad(400, `invalid ${k}`);
    f[k] = v;
  }

  // 3. counts and sizes, from the declared sizes, before any image byte is read.
  if (files.length + (jsonShot !== null ? 1 : 0) > L.MAX_ATTACHMENTS) return bad(413, "too many images");
  if (files.some((x) => x.blob.size > L.MAX_IMAGE_BYTES)) return bad(413, "image too large");
  if (files.reduce((n, x) => n + x.blob.size, 0) > L.MAX_TOTAL_BYTES) return bad(413, "images too large together");
  if (thumbBlob && thumbBlob.size > L.MAX_THUMB_BYTES) return bad(413, "thumb too large");

  const raws: { kind: Img["kind"]; bytes: Uint8Array }[] = [];
  if (jsonShot !== null) {
    const padding = jsonShot.endsWith("==") ? 2 : jsonShot.endsWith("=") ? 1 : 0;
    if ((jsonShot.length * 3) / 4 - padding > L.MAX_IMAGE_BYTES) return bad(413, "screenshot too large");
    try {
      raws.push({ kind: "screenshot", bytes: Uint8Array.from(atob(jsonShot), (c) => c.charCodeAt(0)) });
    } catch {
      return bad(400, "invalid screenshot");
    }
    if (raws[0].bytes.length > L.MAX_IMAGE_BYTES) return bad(413, "screenshot too large");
  }
  const toRead = [...files.map((x) => x.blob), ...(thumbBlob ? [thumbBlob] : [])];
  const read = await Promise.all(toRead.map((x) => x.arrayBuffer()));
  files.forEach((x, i) => raws.push({ kind: x.kind, bytes: new Uint8Array(read[i]) }));
  // 4 + 5. magic bytes, then metadata stripping.
  const prepared = raws.map((r) => prepare(r.bytes, r.kind));
  for (const p of prepared) if (Array.isArray(p)) return bad(p[0], p[1]);
  const imgs = prepared as Img[];
  let thumb: Img | null = null;
  if (thumbBlob) {
    const t = prepare(new Uint8Array(read[files.length]), "photo");
    if (Array.isArray(t)) return bad(t[0], t[1]);
    if (t.mime !== "image/jpeg") return bad(415, "thumb must be jpeg");
    thumb = t;
  }
  if (imgs.length && !env.SHOTS) return bad(500, "misconfigured");
  return { b, text, kind, f, imgs, thumb };
}

/** Insert the row, then write images in parallel; any failure removes what was written and the row. Returns the new id or null. */
async function saveLetter(env: Env, sql: Sql, project: Row, p: Letter, source: "app" | "web", reporter: string | null): Promise<number | null> {
  const { b, text, kind, f, imgs, thumb } = p;
  const [row] = await sql`
    insert into feedback (project_id, kind, text, screen, app_version, build, platform, device, os, locale, url, reporter_hash, source)
    values (${project.id}, ${kind}, ${text}, ${f.screen}, ${f.app_version}, ${f.build}, ${b.platform ?? null}, ${f.device}, ${f.os}, ${f.locale}, ${f.url}, ${reporter}, ${source})
    returning id::int as id`;

  if (imgs.length) {
    // 6. keys <slug>/<id>/<n>.<ext>; parallel puts; any failure removes what was written and the row.
    const base = `${project.slug}/${row.id}`;
    const meta = imgs.map((x, n) => ({ position: n, kind: x.kind, r2_key: `${base}/${n}.${x.ext}`, bytes: x.bytes.length, content_type: x.mime }));
    const thumbKey = thumb ? `${base}/thumb.jpg` : null;
    const keys = [...meta.map((m) => m.r2_key), ...(thumbKey ? [thumbKey] : [])];
    try {
      await Promise.all([
        ...imgs.map((x, n) => env.SHOTS!.put(meta[n].r2_key, x.bytes, { httpMetadata: { contentType: x.mime } })),
        ...(thumb ? [env.SHOTS!.put(thumbKey!, thumb.bytes, { httpMetadata: { contentType: "image/jpeg" } })] : []),
      ]);
      await sql`
        with a as (
          insert into attachments (feedback_id, position, kind, r2_key, bytes, content_type)
          select ${row.id}::bigint, x.position, x.kind, x.r2_key, x.bytes, x.content_type
          from jsonb_to_recordset(${JSON.stringify(meta)}::jsonb) as x(position smallint, kind text, r2_key text, bytes int, content_type text))
        update feedback set thumb_key = ${thumbKey}::text, attachment_count = ${meta.length}::smallint where id = ${row.id}::bigint`;
    } catch {
      await env.SHOTS!.delete(keys).catch(() => {});
      await sql`delete from feedback where id = ${row.id}`;
      return null;
    }
  }
  return row.id;
}


const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const zeroCounts = (rows: Row[] = []) => {
  const o: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) o[r.status] = r.n;
  return o;
};

// ponytail: id::int caps at 2.1 billion rows (and keeps ids numbers on every driver); widen to text if that ever matters.
async function list(url: URL, sql: Sql) {
  const q = url.searchParams;
  const project = q.get("project");
  const kind = q.get("kind");
  if (kind && !KINDS.includes(kind)) return fail(400, "invalid kind");
  const statuses = q.get("status")?.split(",") ?? null;
  if (statuses && !statuses.every((s) => STATUSES.includes(s))) return fail(400, "invalid status");
  const prio = q.get("priority");
  if (prio !== null && !/^[0-3]$|^none$/.test(prio)) return fail(400, "invalid priority");
  const label = q.get("label");
  if (label !== null && !LABEL.test(label)) return fail(400, "invalid label");
  const source = q.get("source");
  if (source !== null && !SOURCES.includes(source)) return fail(400, "invalid source");
  const screen = q.get("screen");
  const build = q.get("build");
  if ((screen?.length ?? 0) > 200 || (build?.length ?? 0) > 200) return fail(400, "invalid filter");
  const text = q.get("q")?.trim() || null;
  if ((text?.length ?? 0) > 200) return fail(400, "invalid q");
  const like = text && `%${likeEscape(text)}%`;
  const sort = q.get("sort") ?? "new";
  if (!["new", "old", "priority"].includes(sort)) return fail(400, "invalid sort");
  // Cursor: the last id, or `<priority 0-4>.<id>` for sort=priority (4 stands for not set).
  const cursor = q.get("cursor");
  const cm = cursor ? (sort === "priority" ? /^([0-4])\.(\d{1,9})$/ : /^()(\d{1,9})$/).exec(cursor) : null;
  if (cursor && !cm) return fail(400, "invalid cursor");
  const cp = cm?.[1] ? Number(cm[1]) : null;
  const cid = cm ? Number(cm[2]) : null;
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), 200);
  const statusCsv = statuses?.join(",") ?? null;
  // A tagged template cannot splice raw SQL, so a null parameter means "no filter".
  const rowsP = sql`select f.id::int as id, p.slug as project, f.kind, f.text, f.status, f.note, f.priority::int as priority, f.labels, f.duplicate_of::int as duplicate_of, f.source, f.screen, f.app_version, f.build, f.platform, f.device, f.os, f.locale, f.url, f.attachment_count::int as attachment_count, (f.thumb_key is not null) as has_thumb, f.created_at, f.updated_at
    from feedback f join projects p on p.id = f.project_id
    where (${project}::text is null or p.slug = ${project}::text)
      and (${statusCsv}::text is null or f.status = any(string_to_array(${statusCsv}::text, ',')))
      and (${kind}::text is null or f.kind = ${kind}::text)
      and (${screen}::text is null or f.screen = ${screen}::text)
      and (${build}::text is null or f.build = ${build}::text)
      and (${prio}::text is null or f.priority::text = ${prio}::text or (${prio}::text = 'none' and f.priority is null))
      and (${label}::text is null or f.labels @> array[${label}::text])
      and (${source}::text is null or f.source = ${source}::text)
      and (${like}::text is null or f.text ilike ${like}::text or f.note ilike ${like}::text)
      and (${cid}::bigint is null
        or (${sort}::text = 'new' and f.id < ${cid}::bigint)
        or (${sort}::text = 'old' and f.id > ${cid}::bigint)
        or (${sort}::text = 'priority' and (coalesce(f.priority, 4), f.id) > (${cp}::int, ${cid}::bigint)))
    order by case when ${sort}::text = 'priority' then coalesce(f.priority, 4) end asc,
      case when ${sort}::text = 'new' then f.id end desc,
      case when ${sort}::text <> 'new' then f.id end asc
    limit ${limit + 1}`;
  // Counts: same project, kind and search filters, not the other facets; first page only, so paging costs nothing extra.
  const countsP = cursor ? null : Promise.all([
    sql`select f.status, count(*)::int as n from feedback f join projects p on p.id = f.project_id
      where (${project}::text is null or p.slug = ${project}::text) and (${kind}::text is null or f.kind = ${kind}::text)
        and (${like}::text is null or f.text ilike ${like}::text or f.note ilike ${like}::text)
      group by f.status`,
    sql`select f.screen, count(*)::int as n from feedback f join projects p on p.id = f.project_id
      where f.screen is not null and (${project}::text is null or p.slug = ${project}::text) and (${kind}::text is null or f.kind = ${kind}::text)
        and (${like}::text is null or f.text ilike ${like}::text or f.note ilike ${like}::text)
      group by f.screen order by n desc, f.screen limit 20`,
  ]);
  const [rows, counts] = await Promise.all([rowsP, countsP]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next = rows.length > limit ? (sort === "priority" ? `${last.priority ?? 4}.${last.id}` : String(last.id)) : null;
  return json({ items, next_cursor: next, ...(counts ? { counts: { status: zeroCounts(counts[0]), screen: counts[1] } } : {}) });
}

async function fetchOne(id: number, sql: Sql) {
  const [row] = await sql`select f.id::int as id, p.slug as project, f.kind, f.text, f.status, f.note, f.priority::int as priority, f.labels, f.duplicate_of::int as duplicate_of, f.source, f.screen, f.app_version, f.build, f.platform, f.device, f.os, f.locale, f.url, f.attachment_count::int as attachment_count, (f.thumb_key is not null) as has_thumb, f.created_at, f.updated_at,
    coalesce((select json_agg(json_build_object('position', a.position, 'kind', a.kind, 'bytes', a.bytes, 'content_type', a.content_type) order by a.position) from attachments a where a.feedback_id = f.id), '[]'::json) as attachments,
    coalesce((select json_agg(json_build_object('id', d.id::int, 'text', left(split_part(d.text, E'\n', 1), 200), 'attachment_count', d.attachment_count::int) order by d.id) from feedback d where d.duplicate_of = f.id), '[]'::json) as duplicates
    from feedback f join projects p on p.id = f.project_id where f.id = ${id}`;
  return row;
}

async function one(id: number, sql: Sql) {
  const row = await fetchOne(id, sql);
  return row ? json(row) : fail(404, "not found");
}

const validLabels = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x === "string" && LABEL.test(x)) ? [...new Set(v as string[])] : null;
const isPrio = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3);
const dbCheck = (e: any) => e?.code === "23514";

async function patch(id: number, req: Request, sql: Sql, L: Limits) {
  let b: Row;
  try {
    b = await req.json();
  } catch {
    return fail(400, "invalid json");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return fail(400, "invalid json");
  const has = (k: string) => b[k] !== undefined;
  if (!["status", "note", "priority", "labels", "duplicate_of"].some(has)) return fail(400, "status, note, priority, labels or duplicate_of required");
  if (has("status") && !STATUSES.includes(b.status)) return fail(400, "invalid status");
  if (has("note") && b.note !== null && (typeof b.note !== "string" || b.note.length > L.MAX_TEXT)) return fail(400, "invalid note");
  if (has("priority") && !isPrio(b.priority)) return fail(400, "invalid priority");
  const labels = has("labels") ? validLabels(b.labels) : null;
  if (has("labels") && !labels) return fail(400, "invalid labels");
  const dup = b.duplicate_of;
  if (has("duplicate_of") && dup !== null && !(Number.isInteger(dup) && dup > 0 && dup < 1e9)) return fail(400, "invalid duplicate_of");
  if (typeof dup === "number") {
    if (dup === id) return fail(400, "a letter cannot be a duplicate of itself");
    if (has("status") && b.status !== "duplicate") return fail(400, "duplicate_of needs status duplicate");
    const rows = await sql`select f.id::int as id, f.project_id, f.status, f.duplicate_of is not null as is_dup,
        exists (select 1 from feedback d where d.duplicate_of = ${id}::bigint) as has_dups
      from feedback f where f.id in (${id}::bigint, ${dup}::bigint)`;
    const me = rows.find((r) => r.id === id);
    const target = rows.find((r) => r.id === dup);
    if (!me) return fail(404, "not found");
    if (!target) return fail(400, "duplicate_of does not exist");
    if (target.project_id !== me.project_id) return fail(400, "duplicate_of must be in the same project");
    if (target.status === "duplicate") return fail(400, "duplicate_of points at a duplicate; use the original");
    if (me.has_dups) return fail(400, "other letters are duplicates of this one");
  } else if (b.status === "duplicate") return fail(400, "status duplicate needs duplicate_of");
  const status = typeof dup === "number" ? "duplicate" : b.status ?? null;
  let rows: Row[];
  try {
    rows = await sql`update feedback set
      status = case when ${status}::text is not null then ${status}::text
                    when ${dup === null}::boolean and status = 'duplicate' then 'new' else status end,
      note = case when ${has("note")}::boolean then ${b.note ?? null}::text else note end,
      priority = case when ${has("priority")}::boolean then ${b.priority ?? null}::smallint else priority end,
      labels = case when ${labels !== null}::boolean then array(select jsonb_array_elements_text(${JSON.stringify(labels ?? [])}::jsonb)) else labels end,
      -- leaving the duplicate status, or clearing the pointer, drops the pointer
      duplicate_of = case when ${typeof dup === "number"}::boolean then ${typeof dup === "number" ? dup : null}::bigint
                          when ${dup === null || (status !== null && status !== "duplicate")}::boolean then null else duplicate_of end,
      updated_at = now()
    where id = ${id} returning id`;
  } catch (e) {
    if (dbCheck(e)) return fail(400, "invalid value");
    throw e;
  }
  if (!rows.length) return fail(404, "not found");
  return json(await fetchOne(id, sql));
}

const BULK_MAX = 200;

async function bulk(req: Request, sql: Sql) {
  let b: Row;
  try {
    b = await req.json();
  } catch {
    return fail(400, "invalid json");
  }
  const ids: unknown = b?.ids;
  if (!Array.isArray(ids) || !ids.length) return fail(400, "ids required");
  if (ids.length > BULK_MAX) return fail(413, `at most ${BULK_MAX} ids`);
  if (!ids.every((x) => Number.isInteger(x) && x > 0 && x < 1e9)) return fail(400, "invalid ids");
  const p = b.patch;
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail(400, "patch required");
  if (!["status", "priority", "labels_add", "labels_remove"].some((k) => p[k] !== undefined)) return fail(400, "empty patch");
  if (p.status !== undefined && (!STATUSES.includes(p.status) || p.status === "duplicate")) return fail(400, p.status === "duplicate" ? "use duplicate_of on one letter" : "invalid status");
  if (p.priority !== undefined && !isPrio(p.priority)) return fail(400, "invalid priority");
  const add = p.labels_add === undefined ? [] : validLabels(p.labels_add);
  const remove = p.labels_remove === undefined ? [] : validLabels(p.labels_remove);
  if (!add || !remove) return fail(400, "invalid labels");
  const uniq = [...new Set(ids as number[])];
  let rows: Row[];
  try {
    // One statement: nothing is updated unless every id exists.
    rows = await sql`with want as (select x::bigint as id from jsonb_array_elements_text(${JSON.stringify(uniq)}::jsonb) x),
      u as (
        update feedback f set
          status = coalesce(${p.status ?? null}::text, f.status),
          priority = case when ${p.priority !== undefined}::boolean then ${p.priority ?? null}::smallint else f.priority end,
          labels = array(select distinct l from unnest(f.labels || array(select jsonb_array_elements_text(${JSON.stringify(add)}::jsonb))) l
                         where l <> all (array(select jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb))) order by l),
          duplicate_of = case when ${p.status ?? null}::text is not null then null else f.duplicate_of end,
          updated_at = now()
        where f.id in (select id from want) and (select count(*) from feedback where id in (select id from want)) = ${uniq.length}
        returning 1)
      select count(*)::int as n from u`;
  } catch (e) {
    if (dbCheck(e)) return fail(400, "too many labels");
    throw e;
  }
  if (rows[0].n !== uniq.length) return fail(404, "some ids do not exist");
  return json({ updated: rows[0].n });
}

async function addLetter(req: Request, env: Env, sql: Sql, L: Limits) {
  const p = await parseLetter(req, env, L, fail);
  if (p instanceof Response) return p;
  const slug = p.b.project;
  if (typeof slug !== "string") return fail(400, "project is required");
  const [project] = await sql`select id::int as id, slug from projects where slug = ${slug}`;
  if (!project) return fail(404, "unknown project");
  const id = await saveLetter(env, sql, project, p, "web", null);
  return id === null ? fail(500, "could not store images") : json({ id }, 201);
}

async function projects(sql: Sql) {
  const rows = await sql`with c as (
      select project_id, jsonb_object_agg(status, n) as counts from (select project_id, status, count(*)::int as n from feedback group by project_id, status) g group by project_id)
    select p.slug, p.name, p.public_key, p.created_at, c.counts from projects p left join c on c.project_id = p.id order by p.id`;
  return json(rows.map((r) => ({ ...r, counts: { ...zeroCounts(), ...(r.counts ?? {}) } })));
}

// Content never changes under a key, so the answer is cacheable by the owner's browser (private) and revalidates by ETag.
async function stream(key: string, mime: string, req: Request, env: Env) {
  if (!env.SHOTS) return fail(500, "misconfigured");
  const obj = await env.SHOTS.get(key, { onlyIf: req.headers });
  if (!obj) return fail(404, "not found");
  const h: Record<string, string> = { "content-type": mime, "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff" };
  if (obj.httpEtag) h.etag = obj.httpEtag;
  return new Response(obj.body ?? null, { status: obj.body ? 200 : 304, headers: h });
}

async function attachment(id: number, position: number, req: Request, env: Env, sql: Sql) {
  const [row] = await sql`select r2_key, content_type from attachments where feedback_id = ${id} and position = ${position}`;
  return row ? stream(row.r2_key, row.content_type, req, env) : fail(404, "no such attachment");
}

async function thumb(id: number, req: Request, env: Env, sql: Sql) {
  const [row] = await sql`select thumb_key from feedback where id = ${id}`;
  return row?.thumb_key ? stream(row.thumb_key, "image/jpeg", req, env) : fail(404, "no thumb");
}

async function createProject(req: Request, sql: Sql) {
  let b: Row;
  try {
    b = await req.json();
  } catch {
    return fail(400, "invalid json");
  }
  if (typeof b?.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(b.slug)) return fail(400, "invalid slug");
  if (typeof b.name !== "string" || b.name.length < 1 || b.name.length > 100) return fail(400, "invalid name");
  const publicKey = "pbk_" + hex(crypto.getRandomValues(new Uint8Array(24)));
  try {
    await sql`insert into projects (slug, name, public_key) values (${b.slug}, ${b.name}, ${publicKey})`;
  } catch (e: any) {
    if (e?.code === "23505") return fail(409, "slug already exists");
    throw e;
  }
  return json({ slug: b.slug, name: b.name, public_key: publicKey }, 201);
}

export async function route(req: Request, env: Env): Promise<Response> {
  if (!env.DATABASE_URL) {
    // /api/limits needs no database, so clients can read it even before the secrets are set.
    const noDb: Sql = async () => { throw new Error("no database"); };
    return new URL(req.url).pathname === "/api/limits" && req.method === "GET" ? handle(req, env, noDb) : fail(500, "misconfigured");
  }
  try {
    return await handle(req, env, neon(env.DATABASE_URL) as unknown as Sql);
  } catch (e) {
    // Never log request bodies or keys; the message of a db error is enough.
    console.error("api error:", e instanceof Error ? e.message : "unknown");
    return fail(500, "internal error");
  }
}
