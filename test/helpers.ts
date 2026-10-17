import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "../lib/migrate.ts";
import { handle, type Env, type R2, type Row, type Sql } from "../lib/api.ts";

export const TOKEN = "test-admin-token";
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString("base64");

export async function setup() {
  const db = new PGlite();
  // PGlite's query() takes one statement; exec() takes many (like a pg simple query without params).
  const migrateDb = { query: async (text: string, params?: unknown[]) => (params ? db.query(text, params) : { rows: (await db.exec(text)).flatMap((r) => r.rows) }) };
  await applyMigrations(migrateDb, new URL("../db/migrations", import.meta.url).pathname);
  const sql: Sql = async (s, ...v) => (await db.query(s.reduce((a, x, i) => a + "$" + i + x), v)).rows as Row[];
  const store = new Map<string, Uint8Array>();
  const hooks = { failPut: (_key: string) => false };
  const shots: R2 = {
    async put(k, v) {
      if (hooks.failPut(k)) throw new Error("r2 down");
      store.set(k, v);
    },
    async get(k, opts) {
      const v = store.get(k);
      if (!v) return null;
      const httpEtag = `"etag-${k}"`;
      if (opts?.onlyIf?.get("if-none-match") === httpEtag) return { httpEtag };
      return { body: new Response(v as BodyInit).body, httpEtag };
    },
    async delete(keys) { for (const k of [keys].flat()) store.delete(k); },
  };
  const env: Env = { DATABASE_URL: "x", ADMIN_TOKEN: TOKEN, SHOTS: shots };
  const call = (path: string, init: RequestInit = {}, e: Env = env) => handle(new Request("https://hub.test" + path, init), e, sql);
  const admin = (path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });
  const created = await admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "demo", name: "Demo" }) });
  const { public_key: key } = (await created.json()) as { public_key: string };
  // The fetch layer adds content-length for real clients; a bare Request does not, so the helpers set it.
  const post = (body: BodyInit | Uint8Array, headers: Record<string, string>, size: number) =>
    call("/api/submit", { method: "POST", headers: { "x-project-key": key, "cf-connecting-ip": "1.1.1.1", "content-length": String(size), ...headers }, body: body as BodyInit });
  const submit = (body: object, headers: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    return post(raw, headers, Buffer.byteLength(raw));
  };
  /** Multipart submit; files are {field, bytes}. */
  const submitForm = async (meta: object, files: { field: string; bytes: Uint8Array }[] = [], headers: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("meta", JSON.stringify(meta));
    for (const f of files) form.append(f.field, new File([f.bytes as BlobPart], "x.bin", { type: "image/png" })); // client type is ignored by the server
    const req = new Request("https://hub.test/x", { method: "POST", body: form });
    const raw = new Uint8Array(await req.arrayBuffer());
    return post(raw, { "content-type": req.headers.get("content-type")!, ...headers }, raw.length);
  };
  return { db, sql, store, env, call, admin, key, submit, submitForm, post, hooks };
}

/** Tiny valid JPEG: SOI, JFIF, optional extra segments, SOF0, SOS + entropy data (with a stuffed FF00), EOI. */
export function jpeg(extra: Uint8Array[] = [], tail: number[] = []): Uint8Array {
  const seg = (m: number, body: number[]) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const parts = [
    [0xff, 0xd8],
    seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...extra.map((e) => [...e]),
    seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    [0x12, 0xff, 0x00, 0x34],
    [0xff, 0xd9],
    tail,
  ];
  return Uint8Array.from(parts.flat());
}
export const exifSegment = (): Uint8Array => Uint8Array.from([0xff, 0xe1, 0, 14, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50, 0x53, 1, 2, 3]); // "Exif" + fake GPS bytes
export const png = (n = 16): Uint8Array => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(n).fill(7)]);
export const JPEG = Buffer.from(jpeg()).toString("base64");
