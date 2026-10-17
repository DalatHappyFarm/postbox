import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../lib/migrate.ts";
import { exifSegment, jpeg, png, setup } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });

const meta = { text: "photos", kind: "bug", device_id: "d1" };
const id = async (res: Response) => ((await res.json()) as { id: number }).id;
const has = (b: Uint8Array, m: number) => b.some((x, i) => x === 0xff && b[i + 1] === m);

/** A request whose body must never be read: pulling from it fails the test. */
function unreadable(headers: Record<string, string>) {
  const body = new ReadableStream({ pull() { throw new Error("body was read"); } });
  return new Request("https://hub.test/api/submit", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe("multipart submit", () => {
  it("stores screenshot + 2 photos + thumb in order with metadata rows", async () => {
    const shot = png(100);
    const p1 = jpeg([exifSegment()]);
    const p2 = png(50);
    const th = jpeg();
    const res = await t.submitForm(meta, [
      { field: "screenshot", bytes: shot }, { field: "photo", bytes: p1 }, { field: "photo", bytes: p2 }, { field: "thumb", bytes: th },
    ]);
    expect(res.status).toBe(201);
    const fid = await id(res);
    expect([...t.store.keys()].sort()).toEqual([0, 1, 2].map((n) => `demo/${fid}/${n}.${n === 1 ? "jpg" : "png"}`).concat(`demo/${fid}/thumb.jpg`).sort());
    const item = (await (await t.admin(`/api/feedback/${fid}`)).json()) as any;
    expect(item.attachment_count).toBe(3);
    expect(item.has_thumb).toBe(true);
    expect(item.attachments).toEqual([
      { position: 0, kind: "screenshot", bytes: shot.length, content_type: "image/png" },
      { position: 1, kind: "photo", bytes: jpeg().length, content_type: "image/jpeg" }, // stored size is after stripping
      { position: 2, kind: "photo", bytes: p2.length, content_type: "image/png" },
    ]);
    const list = (await (await t.admin("/api/feedback")).json()) as any;
    expect(list.items[0]).toMatchObject({ id: fid, attachment_count: 3, has_thumb: true });
  });

  it("strips EXIF on the server and keeps the image segments", async () => {
    const dirty = jpeg([exifSegment()]);
    const fid = await id(await t.submitForm(meta, [{ field: "photo", bytes: dirty }]));
    const stored = t.store.get(`demo/${fid}/0.jpg`)!;
    expect(has(stored, 0xe1)).toBe(false);
    expect(Buffer.from(stored).includes(Buffer.from("Exif"))).toBe(false);
    expect(stored).toEqual(jpeg());
    // JSON path strips too
    const jid = await id(await t.submit({ text: "x", screenshot: Buffer.from(dirty).toString("base64") }));
    expect(t.store.get(`demo/${jid}/0.jpg`)).toEqual(jpeg());
  });

  it("accepts a form with no images", async () => {
    expect((await t.submitForm(meta)).status).toBe(201);
    expect(t.store.size).toBe(0);
  });

  it("rejects too many files (screenshot counts)", async () => {
    const files = [{ field: "screenshot", bytes: png() }, ...[1, 2, 3, 4].map(() => ({ field: "photo", bytes: png() }))];
    expect((await t.submitForm(meta, files)).status).toBe(413);
    expect((await t.submitForm(meta, files.slice(0, 4))).status).toBe(201);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 1 });
    // the limit follows the variable
    const form = new FormData();
    form.set("meta", JSON.stringify(meta));
    form.append("photo", new File([png() as BlobPart], "a"));
    form.append("photo", new File([png() as BlobPart], "b"));
    const req = new Request("https://hub.test/x", { method: "POST", body: form });
    const raw = new Uint8Array(await req.arrayBuffer());
    const res = await t.call("/api/submit", { method: "POST", headers: { "x-project-key": t.key, "content-type": req.headers.get("content-type")!, "content-length": String(raw.length) }, body: raw }, { ...t.env, MAX_ATTACHMENTS: "1" });
    expect(res.status).toBe(413);
  });

  it("enforces the per-image and the total cap", async () => {
    const big = (n: number) => Uint8Array.from([...png(0), ...new Array(n - 8).fill(1)]);
    const env = { ...t.env, MAX_IMAGE_BYTES: "1000", MAX_TOTAL_BYTES: "1500" };
    const form = async (sizes: number[]) => {
      const f = new FormData();
      f.set("meta", JSON.stringify(meta));
      for (const n of sizes) f.append("photo", new File([big(n) as BlobPart], "p"));
      const req = new Request("https://hub.test/x", { method: "POST", body: f });
      const raw = new Uint8Array(await req.arrayBuffer());
      return t.call("/api/submit", { method: "POST", headers: { "x-project-key": t.key, "content-type": req.headers.get("content-type")!, "content-length": String(raw.length) }, body: raw }, env);
    };
    expect((await form([1001])).status).toBe(413);
    expect((await form([900, 700])).status).toBe(413);
    expect((await form([700, 700])).status).toBe(201);
    expect((await form([1000])).status).toBe(201);
  });

  it("rejects an oversize thumb", async () => {
    const th = Uint8Array.from([...jpeg().subarray(0, 3), ...new Array(65537).fill(0)]);
    expect((await t.submitForm(meta, [{ field: "thumb", bytes: th }])).status).toBe(413);
  });

  it("rejects non-images by magic bytes even with an image content type", async () => {
    const gif = Uint8Array.from([...Buffer.from("GIF89a"), 1, 2, 3]);
    expect((await t.submitForm(meta, [{ field: "photo", bytes: gif }])).status).toBe(415); // helper labels every file image/png
    expect((await t.submitForm(meta, [{ field: "photo", bytes: Buffer.from("<script>alert(1)</script>") }])).status).toBe(415);
    expect((await t.submitForm(meta, [{ field: "photo", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1, 2]) }])).status).toBe(415); // jpeg magic, broken body
    expect((await t.submitForm(meta, [{ field: "thumb", bytes: png() }])).status).toBe(415); // thumb must be jpeg
    expect(t.store.size).toBe(0);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
  });

  it("rejects a bad form: missing meta, string where a file belongs", async () => {
    const f = new FormData();
    f.set("photo", "not a file");
    const noMeta = new Request("https://hub.test/x", { method: "POST", body: f });
    const raw = new Uint8Array(await noMeta.arrayBuffer());
    const post = (body: Uint8Array, ct: string) => t.post(body, { "content-type": ct }, body.length);
    expect((await post(raw, noMeta.headers.get("content-type")!)).status).toBe(400);
    expect((await post(Buffer.from("junk"), "multipart/form-data; boundary=x")).status).toBe(400);
    const g = new FormData();
    g.set("meta", JSON.stringify(meta));
    g.set("screenshot", "string");
    const r2 = new Request("https://hub.test/x", { method: "POST", body: g });
    expect((await post(new Uint8Array(await r2.arrayBuffer()), r2.headers.get("content-type")!)).status).toBe(400);
  });

  it("deletes the row and every written object when a put fails", async () => {
    t.hooks.failPut = (k) => k.endsWith("/1.png");
    const res = await t.submitForm(meta, [{ field: "photo", bytes: png() }, { field: "photo", bytes: png() }, { field: "thumb", bytes: jpeg() }]);
    expect(res.status).toBe(500);
    expect(t.store.size).toBe(0);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
    expect((await t.db.query("select count(*)::int as n from attachments")).rows[0]).toEqual({ n: 0 });
  });
});

describe("check order", () => {
  const headers = (extra: Record<string, string> = {}) => ({ "content-type": "multipart/form-data; boundary=x", "content-length": "100", "cf-connecting-ip": "1.1.1.1", ...extra });

  it("bad or missing key answers 401 without reading the body", async () => {
    for (const h of [headers(), headers({ "x-project-key": "nope" })]) {
      const req = unreadable(h);
      expect((await t.call("/api/submit", req)).status).toBe(401);
      expect(req.bodyUsed).toBe(false);
    }
  });

  it("rate limit answers 429 without reading the body", async () => {
    await t.db.query("insert into submit_log (project_id, reporter_hash) select 1, 'h' || g from generate_series(1, 200) g");
    const req = unreadable(headers({ "x-project-key": t.key }));
    expect((await t.call("/api/submit", req)).status).toBe(429);
    expect(req.bodyUsed).toBe(false);
  });

  it("missing Content-Length answers 411 and too large answers 413, body unread", async () => {
    const missing = unreadable({ "content-type": "multipart/form-data; boundary=x", "x-project-key": t.key });
    expect((await t.call("/api/submit", missing)).status).toBe(411);
    expect(missing.bodyUsed).toBe(false);
    const limit = 15728640 + 65536 + 64 * 1024;
    for (const [n, status] of [[limit + 1, 413], [String(limit), 400]] as const) {
      const req = new Request("https://hub.test/api/submit", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "x-project-key": t.key, "content-length": String(n) }, body: "tiny" });
      const res = await t.call("/api/submit", req);
      expect(res.status).toBe(status); // at the limit the body is parsed (and rejected as junk here)
      if (status === 413) expect(req.bodyUsed).toBe(false);
    }
    const json = unreadable({ "content-type": "application/json", "x-project-key": t.key, "content-length": "99999999" });
    expect((await t.call("/api/submit", json)).status).toBe(413);
    expect(json.bodyUsed).toBe(false);
  });
});

describe("JSON path", () => {
  it("still works and stores the screenshot as attachment 0", async () => {
    const png64 = Buffer.from(png()).toString("base64");
    const fid = await id(await t.submit({ text: "old kit", screenshot: png64 }));
    const row = (await t.db.query("select position, kind, r2_key, content_type from attachments where feedback_id = $1", [fid])).rows;
    expect(row).toEqual([{ position: 0, kind: "screenshot", r2_key: `demo/${fid}/0.png`, content_type: "image/png" }]);
    expect((await t.db.query("select attachment_count, screenshot_key from feedback where id = $1", [fid])).rows[0]).toEqual({ attachment_count: 1, screenshot_key: null });
  });
});

describe("admin attachment endpoints", () => {
  it("streams attachments, thumb and the screenshot alias with immutable private caching and ETag", async () => {
    const p1 = png(40);
    const fid = await id(await t.submitForm(meta, [{ field: "screenshot", bytes: png(10) }, { field: "photo", bytes: p1 }, { field: "thumb", bytes: jpeg() }]));
    const get = (path: string, h: Record<string, string> = {}) => t.admin(`/api/feedback/${fid}${path}`, { headers: h });
    const a1 = await get("/attachments/1");
    expect(a1.status).toBe(200);
    expect(a1.headers.get("content-type")).toBe("image/png");
    expect(a1.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(a1.headers.get("etag")).toBe(`"etag-demo/${fid}/1.png"`);
    expect(new Uint8Array(await a1.arrayBuffer())).toEqual(p1);
    const th = await get("/thumb");
    expect(th.headers.get("content-type")).toBe("image/jpeg");
    expect(th.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(th.headers.get("etag")).toBeTruthy();
    const alias = await get("/screenshot");
    expect(new Uint8Array(await alias.arrayBuffer())).toEqual(png(10));
    const again = await get("/attachments/1", { "if-none-match": a1.headers.get("etag")! });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(a1.headers.get("etag"));
    expect((await get("/attachments/9")).status).toBe(404);
    expect((await get("/attachments/x")).status).toBe(404);
    expect((await t.call(`/api/feedback/${fid}/attachments/0`)).status).toBe(401);
    expect((await t.call(`/api/feedback/${fid}/thumb`)).status).toBe(401);
  });
});

describe("migration 0002", () => {
  it("copies existing screenshot_key rows as attachment 0 on a database that already has 0001 data", async () => {
    const db = new PGlite();
    const mdb = { query: async (text: string, params?: unknown[]) => (params ? db.query(text, params) : { rows: (await db.exec(text)).flatMap((r) => r.rows) }) };
    const dir = mkdtempSync(join(tmpdir(), "postbox-mig-"));
    const real = new URL("../db/migrations", import.meta.url).pathname;
    copyFileSync(join(real, "0001_init.sql"), join(dir, "0001_init.sql"));
    expect(await applyMigrations(mdb, dir)).toEqual(["0001_init.sql"]);
    await db.exec(`
      insert into projects (slug, name, public_key) values ('demo', 'Demo', 'pbk_${"a".repeat(20)}');
      insert into feedback (project_id, kind, text, screenshot_key) values
        (1, 'bug', 'with png', 'demo/1.png'), (1, 'bug', 'with jpg', 'demo/2.jpg'), (1, 'idea', 'none', null);`);
    expect(await applyMigrations(mdb, real)).toEqual(["0002_attachments.sql"]);
    expect((await db.query("select feedback_id::int as f, position, kind, r2_key, bytes, content_type from attachments order by feedback_id")).rows).toEqual([
      { f: 1, position: 0, kind: "screenshot", r2_key: "demo/1.png", bytes: null, content_type: "image/png" },
      { f: 2, position: 0, kind: "screenshot", r2_key: "demo/2.jpg", bytes: null, content_type: "image/jpeg" },
    ]);
    expect((await db.query("select id::int as id, attachment_count::int as n, thumb_key, screenshot_key from feedback order by id")).rows).toEqual([
      { id: 1, n: 1, thumb_key: null, screenshot_key: "demo/1.png" },
      { id: 2, n: 1, thumb_key: null, screenshot_key: "demo/2.jpg" },
      { id: 3, n: 0, thumb_key: null, screenshot_key: null },
    ]);
    await db.query("delete from feedback where id = 1"); // cascade
    expect((await db.query("select count(*)::int as n from attachments")).rows[0]).toEqual({ n: 1 });
  });
});
