import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../lib/migrate.ts";
import { exifSegment, jpeg, png, setup } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });

type L = { screen?: string | null; build?: string; status?: string; priority?: number | null; labels?: string[]; source?: string; text?: string; note?: string; kind?: string; project?: number };
/** Direct insert; ids come out 1, 2, 3 ... in call order. */
async function seed(rows: L[]) {
  for (const r of rows) {
    await t.db.query(
      "insert into feedback (project_id, kind, text, note, screen, build, status, priority, labels, source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10)",
      [r.project ?? 1, r.kind ?? "bug", r.text ?? "letter", r.note ?? null, r.screen ?? null, r.build ?? null, r.status ?? "new", r.priority ?? null, r.labels ?? [], r.source ?? "app"],
    );
  }
}
const get = async (path: string) => (await t.admin(path)).json() as Promise<any>;
const ids = async (qs: string) => (await get(`/api/feedback?${qs}`)).items.map((i: any) => i.id);
const patch = (id: number, body: unknown) => t.admin(`/api/feedback/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const bulk = (body: unknown) => t.admin("/api/feedback/bulk", { method: "POST", body: JSON.stringify(body) });

describe("migration 0003", () => {
  it("applies on top of 0001+0002 data and keeps it", async () => {
    const db = new PGlite();
    const mdb = { query: async (text: string, params?: unknown[]) => (params ? db.query(text, params) : { rows: (await db.exec(text)).flatMap((r) => r.rows) }) };
    const dir = mkdtempSync(join(tmpdir(), "postbox-mig3-"));
    const real = new URL("../db/migrations", import.meta.url).pathname;
    for (const f of ["0001_init.sql", "0002_attachments.sql"]) copyFileSync(join(real, f), join(dir, f));
    await applyMigrations(mdb, dir);
    await db.exec(`insert into projects (slug, name, public_key) values ('demo', 'Demo', 'pbk_${"a".repeat(20)}'), ('other', 'Other', 'pbk_${"b".repeat(20)}');
      insert into feedback (project_id, kind, text, status) values (1, 'bug', 'old one', 'doing'), (1, 'idea', 'old two', 'new'), (2, 'bug', 'elsewhere', 'new');`);
    expect(await applyMigrations(mdb, real)).toEqual(["0003_triage.sql"]);
    expect((await db.query("select id::int as id, status, priority, labels, duplicate_of, source from feedback order by id")).rows).toEqual([
      { id: 1, status: "doing", priority: null, labels: [], duplicate_of: null, source: "app" },
      { id: 2, status: "new", priority: null, labels: [], duplicate_of: null, source: "app" },
      { id: 3, status: "new", priority: null, labels: [], duplicate_of: null, source: "app" },
    ]);
    const bad = async (q: string) => { await expect(db.query(q)).rejects.toThrow(); };
    await db.query("update feedback set status = 'ready', priority = 0, labels = '{a-1,b}', duplicate_of = 2 where id = 1");
    await bad("update feedback set status = 'bogus' where id = 1");
    await bad("update feedback set priority = 4 where id = 1");
    await bad("update feedback set priority = -1 where id = 1");
    await bad("update feedback set labels = '{Upper}' where id = 1");
    await bad("update feedback set labels = '{\"has space\"}' where id = 1");
    await bad(`update feedback set labels = '{${"x".repeat(33)}}' where id = 1`);
    await bad("update feedback set labels = '{a,b,c,d,e,f,g,h,i}' where id = 1");
    await bad("update feedback set labels = '{\"\"}' where id = 1");
    await bad("update feedback set source = 'sms' where id = 1");
    await bad("update feedback set duplicate_of = 1 where id = 1"); // self
    await bad("update feedback set duplicate_of = 3 where id = 1"); // other project (trigger)
    await bad("insert into feedback (project_id, kind, text, duplicate_of) values (2, 'bug', 'x', 1)");
    await db.query("delete from feedback where id = 2"); // on delete set null
    expect((await db.query("select duplicate_of from feedback where id = 1")).rows[0]).toEqual({ duplicate_of: null });
  });
});

describe("list filters", () => {
  beforeEach(async () => {
    await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "acme-app", name: "Acme" }) });
    await seed([
      { screen: "Home", build: "1", priority: 0, labels: ["ui"], text: "Crash on Launch", source: "app" }, // 1
      { screen: "Home", build: "2", priority: 2, labels: ["ui", "perf"], text: "slow list", note: "Needs LAUNCH profiling" }, // 2
      { screen: "Settings", build: "2", priority: null, status: "ready", text: "100% broken_title", source: "web", kind: "idea" }, // 3
      { screen: "Settings", build: "1", priority: 1, status: "done", text: "plain" }, // 4
      { screen: null, priority: 3, status: "wont_fix", text: "other project", project: 2 }, // 5
    ]);
  });

  it("each filter", async () => {
    expect(await ids("")).toEqual([5, 4, 3, 2, 1]);
    expect(await ids("project=demo")).toEqual([4, 3, 2, 1]);
    expect(await ids("project=acme-app")).toEqual([5]);
    expect(await ids("project=demo&screen=Home")).toEqual([2, 1]);
    expect(await ids("build=2")).toEqual([3, 2]);
    expect(await ids("priority=0")).toEqual([1]);
    expect(await ids("priority=none")).toEqual([3]);
    expect(await ids("label=ui")).toEqual([2, 1]);
    expect(await ids("label=perf")).toEqual([2]);
    expect(await ids("source=web")).toEqual([3]);
    expect(await ids("source=app&project=demo")).toEqual([4, 2, 1]);
    expect(await ids("kind=idea")).toEqual([3]);
    expect(await ids("status=ready")).toEqual([3]);
    expect(await ids("status=new,ready")).toEqual([3, 2, 1]);
    expect(await ids("status=new,done&screen=Settings")).toEqual([4]);
  });

  it("q searches text and note, case-insensitive, and escapes wildcards", async () => {
    expect(await ids("q=launch")).toEqual([2, 1]);
    expect(await ids("q=SLOW")).toEqual([2]);
    expect(await ids("q=100%25")).toEqual([3]);
    expect(await ids("q=%25")).toEqual([3]); // a literal percent, not a wildcard
    expect(await ids("q=_")).toEqual([3]); // a literal underscore
    expect(await ids("q=nomatch")).toEqual([]);
  });

  it("rejects invalid filters", async () => {
    for (const qs of ["status=new,bogus", "status=", "priority=4", "priority=x", "label=Bad Label", "source=sms", "sort=random", "kind=rant", "cursor=abc", "q=" + "x".repeat(201), "screen=" + "x".repeat(201)])
      expect((await t.admin(`/api/feedback?${qs}`)).status, qs).toBe(400);
    expect((await t.admin("/api/feedback?sort=priority&cursor=5.1")).status).toBe(400);
  });

  it("items carry the new fields", async () => {
    const item = (await get("/api/feedback?project=demo")).items.find((i: any) => i.id === 2);
    expect(item).toMatchObject({ priority: 2, labels: ["ui", "perf"], duplicate_of: null, source: "app", status: "new" });
  });

  it("sort orders and paging with cursors", async () => {
    expect(await ids("project=demo&sort=old")).toEqual([1, 2, 3, 4]);
    expect(await ids("project=demo&sort=priority")).toEqual([1, 4, 2, 3]); // 0, 1, 2, then not set
    await seed([{ priority: 1 }, { priority: 1 }, { priority: null }]); // 6, 7, 8
    for (const [sort, want] of [["new", [8, 7, 6, 5, 4, 3, 2, 1]], ["old", [1, 2, 3, 4, 5, 6, 7, 8]], ["priority", [1, 4, 6, 7, 2, 5, 3, 8]]] as const) {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const r: any = await get(`/api/feedback?sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...r.items.map((i: any) => i.id));
        cursor = r.next_cursor;
      } while (cursor);
      expect(seen, sort).toEqual(want);
    }
  });

  it("counts: all statuses, top screens, same project/kind/search filters, not the status filter, first page only", async () => {
    const all = await get("/api/feedback?project=demo&status=done");
    expect(all.counts).toEqual({
      status: { new: 2, ready: 1, doing: 0, done: 1, wont_fix: 0, duplicate: 0 },
      screen: [{ screen: "Home", n: 2 }, { screen: "Settings", n: 2 }],
    });
    expect((await get("/api/feedback?project=demo&kind=bug")).counts.status).toMatchObject({ new: 2, ready: 0, done: 1 });
    expect((await get("/api/feedback?project=demo&q=launch")).counts).toEqual({ status: expect.objectContaining({ new: 2 }), screen: [{ screen: "Home", n: 2 }] });
    expect((await get("/api/feedback?project=demo&screen=Home&label=ui")).counts.status.done).toBe(1); // facets do not narrow counts
    const page = await get("/api/feedback?limit=2");
    expect(page.next_cursor).toBeTruthy();
    expect((await get(`/api/feedback?limit=2&cursor=${page.next_cursor}`)).counts).toBeUndefined();
  });

  it("counts: screens are capped at 20, busiest first, and run as grouped statements (not per letter)", async () => {
    await seed(Array.from({ length: 25 }, (_, n) => ({ screen: `S${String(n).padStart(2, "0")}` })));
    await seed([{ screen: "S24" }, { screen: "S24" }]);
    const c = (await get("/api/feedback")).counts;
    expect(c.screen).toHaveLength(20);
    expect(c.screen[0]).toEqual({ screen: "S24", n: 3 });
    let n = 0;
    const counting = ((s: TemplateStringsArray, ...v: unknown[]) => { n++; return t.sql(s, ...v); }) as typeof t.sql;
    const { handle } = await import("../lib/api.ts");
    await handle(new Request("https://hub.test/api/feedback", { headers: { authorization: "Bearer test-admin-token" } }), t.env, counting);
    expect(n).toBe(3); // list + status counts + screen counts
  });
});

describe("detail and PATCH", () => {
  beforeEach(async () => {
    await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "acme-app", name: "Acme" }) });
    await seed([{ text: "original\nsecond line" }, { text: "copy one" }, { text: "copy two" }, { project: 2, text: "elsewhere" }]); // 1..4
  });

  it("accepts priority, labels (deduped), note and returns the new detail", async () => {
    const r = await patch(1, { priority: 1, labels: ["ui", "ui", "a-1"], note: "do it" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ priority: 1, labels: ["ui", "a-1"], note: "do it", status: "new", source: "app", duplicates: [] });
    expect((await (await patch(1, { priority: null })).json() as any).priority).toBeNull();
    expect((await (await patch(1, { labels: [] })).json() as any).labels).toEqual([]);
    expect((await (await patch(1, { status: "ready" })).json() as any)).toMatchObject({ status: "ready", note: "do it" }); // untouched fields stay
  });

  it("validates", async () => {
    for (const body of [{}, { priority: 4 }, { priority: -1 }, { priority: 1.5 }, { priority: "1" }, { labels: "ui" }, { labels: ["Bad"] }, { labels: ["a b"] }, { labels: [""] },
      { labels: ["x".repeat(33)] }, { labels: Array.from({ length: 9 }, (_, n) => `l${n}`) }, { labels: [1] }, { status: "open" }, { note: "x".repeat(4001) },
      { duplicate_of: "1" }, { duplicate_of: 0 }, { duplicate_of: 1.5 }, { duplicate_of: 1e10 }, { status: "duplicate" }, { duplicate_of: 1, status: "done" }])
      expect((await patch(2, body)).status, JSON.stringify(body)).toBe(400);
    expect((await patch(2, [])).status).toBe(400);
    expect((await patch(99, { priority: 1 })).status).toBe(404);
    expect((await patch(2, { labels: Array.from({ length: 8 }, (_, n) => `l${n}`) })).status).toBe(200);
  });

  it("duplicate_of: sets status, lists duplicates on the original, rejects self, other project, missing, chains", async () => {
    const r = await patch(2, { duplicate_of: 1 });
    expect(await r.json()).toMatchObject({ status: "duplicate", duplicate_of: 1 });
    await patch(3, { duplicate_of: 1 });
    const orig = await get("/api/feedback/1");
    expect(orig.duplicates).toEqual([{ id: 2, text: "copy one", attachment_count: 0 }, { id: 3, text: "copy two", attachment_count: 0 }]);
    expect((await get("/api/feedback/1")).text).toBe("original\nsecond line");
    expect((await patch(2, { duplicate_of: 2 })).status).toBe(400);
    expect((await patch(2, { duplicate_of: 4 })).status).toBe(400); // other project
    expect((await patch(2, { duplicate_of: 77 })).status).toBe(400);
    expect((await patch(4, { duplicate_of: 77 })).status).toBe(400);
    expect((await patch(99, { duplicate_of: 1 })).status).toBe(404);
    expect((await patch(4, { duplicate_of: 2 })).status).toBe(400); // target is itself a duplicate
    expect((await patch(1, { duplicate_of: 4 })).status).toBe(400);
    await t.db.query("insert into feedback (project_id, kind, text) values (1, 'bug', 'later')"); // 5
    expect((await patch(1, { duplicate_of: 5 })).status).toBe(400); // others point at 1
  });

  it("leaving duplicate drops the pointer; clearing the pointer resets the status", async () => {
    await patch(2, { duplicate_of: 1 });
    expect(await (await patch(2, { status: "ready" })).json()).toMatchObject({ status: "ready", duplicate_of: null });
    await patch(2, { duplicate_of: 1 });
    expect(await (await patch(2, { duplicate_of: null })).json()).toMatchObject({ status: "new", duplicate_of: null });
    await patch(2, { duplicate_of: 1 });
    await patch(2, { note: "kept" }); // unrelated patch keeps the pointer
    expect(await get("/api/feedback/2")).toMatchObject({ status: "duplicate", duplicate_of: 1, note: "kept" });
  });

  it("requires admin", async () => {
    expect((await t.call("/api/feedback/1", { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await t.call("/api/feedback/bulk", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await t.call("/api/feedback", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("bulk", () => {
  beforeEach(async () => {
    await seed([{ labels: ["a", "b"] }, { labels: ["b"], priority: 2 }, { labels: [] }, { status: "duplicate" }]); // 4 has no pointer; fine for the test
  });

  it("sets status and priority on many in one call", async () => {
    const r = await bulk({ ids: [1, 2, 3], patch: { status: "ready", priority: 0 } });
    expect(await r.json()).toEqual({ updated: 3 });
    expect((await t.db.query("select status, priority from feedback order by id")).rows.map((x: any) => `${x.status}/${x.priority}`)).toEqual(["ready/0", "ready/0", "ready/0", "duplicate/null"]);
    await bulk({ ids: [1], patch: { priority: null } });
    expect((await get("/api/feedback/1")).priority).toBeNull();
  });

  it("adds and removes labels, deduped and sorted", async () => {
    await bulk({ ids: [1, 2, 3], patch: { labels_add: ["z", "b"], labels_remove: ["a"] } });
    expect((await t.db.query("select labels from feedback order by id")).rows.map((x: any) => x.labels)).toEqual([["b", "z"], ["b", "z"], ["b", "z"], []]);
  });

  it("changing status of a duplicate drops its pointer; duplicate status is refused", async () => {
    await t.db.query("update feedback set duplicate_of = 1 where id = 4");
    await bulk({ ids: [4], patch: { status: "new" } });
    expect((await get("/api/feedback/4"))).toMatchObject({ status: "new", duplicate_of: null });
    expect((await bulk({ ids: [1], patch: { status: "duplicate" } })).status).toBe(400);
  });

  it("limits: 200 ids max, all ids must exist (nothing changes otherwise), validation", async () => {
    const many = Array.from({ length: 201 }, (_, n) => n + 1);
    expect((await bulk({ ids: many, patch: { status: "done" } })).status).toBe(413);
    expect((await bulk({ ids: [1, 2, 99], patch: { status: "done" } })).status).toBe(404);
    expect((await t.db.query("select count(*)::int as n from feedback where status = 'done'")).rows[0]).toEqual({ n: 0 });
    expect((await bulk({ ids: [1, 1, 2], patch: { status: "done" } })).status).toBe(200); // duplicates in ids collapse
    const exact = Array.from({ length: 200 }, (_, n) => n + 1);
    expect((await bulk({ ids: exact, patch: { status: "done" } })).status).toBe(404); // 200 allowed in size, but ids 5..200 missing
    for (const body of [{}, { ids: [], patch: { status: "done" } }, { ids: "1", patch: {} }, { ids: [1], patch: {} }, { ids: [1] }, { ids: [1.5], patch: { status: "done" } },
      { ids: [0], patch: { status: "done" } }, { ids: [1], patch: { status: "open" } }, { ids: [1], patch: { priority: 9 } }, { ids: [1], patch: { labels_add: ["Bad"] } },
      { ids: [1], patch: { labels_remove: "x" } }, { ids: [1], patch: { bogus: 1 } }, []])
      expect((await bulk(body)).status, JSON.stringify(body)).toBe(400);
  });

  it("more than 8 labels is a 400, nothing changes", async () => {
    await bulk({ ids: [1], patch: { labels_add: ["c", "d", "e", "f", "g", "h"] } }); // a b + 6 = 8
    expect((await bulk({ ids: [1, 3], patch: { labels_add: ["x"] } })).status).toBe(400);
    expect((await get("/api/feedback/3")).labels).toEqual([]);
  });
});

describe("add a letter by hand (POST /api/feedback)", () => {
  const add = async (meta: object | null, files: { field: string; bytes: Uint8Array }[] = [], headers: Record<string, string> = { authorization: "Bearer test-admin-token" }) => {
    const form = new FormData();
    if (meta) form.set("meta", JSON.stringify(meta));
    for (const f of files) form.append(f.field, new File([f.bytes as BlobPart], "x.bin"));
    const req = new Request("https://hub.test/x", { method: "POST", body: form });
    const raw = new Uint8Array(await req.arrayBuffer());
    return t.call("/api/feedback", { method: "POST", headers: { "content-type": req.headers.get("content-type")!, "content-length": String(raw.length), ...headers }, body: raw as BodyInit });
  };

  it("needs the admin token, not the project key", async () => {
    expect((await add({ project: "demo", text: "x" }, [], {})).status).toBe(401);
    expect((await add({ project: "demo", text: "x" }, [], { "x-project-key": t.key })).status).toBe(401);
  });

  it("stores a letter with source web, photos and thumb; no rate limit and no submit_log row", async () => {
    const th = jpeg();
    const res = await add({ project: "demo", kind: "idea", text: " from a chat ", screen: "Home" }, [{ field: "photo", bytes: png() }, { field: "photo", bytes: jpeg() }, { field: "thumb", bytes: th }]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(await get(`/api/feedback/${id}`)).toMatchObject({ project: "demo", kind: "idea", text: "from a chat", source: "web", status: "new", attachment_count: 2, has_thumb: true, screen: "Home" });
    expect([...t.store.keys()].sort()).toEqual([`demo/${id}/0.png`, `demo/${id}/1.jpg`, `demo/${id}/thumb.jpg`]);
    expect((await t.db.query("select reporter_hash from feedback")).rows[0]).toEqual({ reporter_hash: null });
    expect((await t.db.query("select count(*)::int as n from submit_log")).rows[0]).toEqual({ n: 0 });
    for (let i = 0; i < 25; i++) expect((await add({ project: "demo", text: `n${i}` })).status).toBe(201); // above the per-device limit of 20
  });

  it("validates project, text, kind", async () => {
    expect((await add({ text: "x" })).status).toBe(400);
    expect((await add({ project: 5, text: "x" })).status).toBe(400);
    expect((await add({ project: "nope", text: "x" })).status).toBe(404);
    expect((await add({ project: "demo", text: " " })).status).toBe(400);
    expect((await add({ project: "demo", text: "x".repeat(4001) })).status).toBe(413);
    expect((await add({ project: "demo", text: "x", kind: "rant" })).status).toBe(400);
    expect((await add(null)).status).toBe(400);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
  });

  it("limits and magic bytes", async () => {
    const meta = { project: "demo", text: "x" };
    expect((await add(meta, Array.from({ length: 5 }, () => ({ field: "photo", bytes: png() })))).status).toBe(413);
    expect((await add(meta, [{ field: "photo", bytes: Buffer.alloc(5_242_881, 1) }])).status).toBe(413);
    expect((await add(meta, [{ field: "photo", bytes: Buffer.from("GIF89a....") }])).status).toBe(415);
    expect((await add(meta, [{ field: "photo", bytes: Buffer.from("<script>") }])).status).toBe(415);
    expect((await add(meta, [{ field: "photo", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1, 2]) }])).status).toBe(415);
    expect((await add(meta, [{ field: "thumb", bytes: png() }])).status).toBe(415);
    const big = new Request("https://hub.test/api/feedback", { method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "multipart/form-data; boundary=x", "content-length": String(99_999_999) }, body: "x" });
    expect((await t.call("/api/feedback", { method: "POST", headers: Object.fromEntries(big.headers), body: "x" })).status).toBe(413);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
    expect(t.store.size).toBe(0);
  });

  it("strips JPEG metadata (EXIF, GPS) before storing", async () => {
    const withExif = jpeg([exifSegment()], [1, 2, 3]);
    const { id } = (await (await add({ project: "demo", text: "x" }, [{ field: "photo", bytes: withExif }])).json()) as { id: number };
    const stored = t.store.get(`demo/${id}/0.jpg`)!;
    expect(Buffer.from(stored).includes(Buffer.from("Exif"))).toBe(false);
    expect(stored.length).toBeLessThan(withExif.length);
  });

  it("cleans up the row and the files when R2 fails", async () => {
    t.hooks.failPut = (k) => k.endsWith("1.png");
    const res = await add({ project: "demo", text: "x" }, [{ field: "photo", bytes: png() }, { field: "photo", bytes: png(20) }]);
    expect(res.status).toBe(500);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
    expect(t.store.size).toBe(0);
  });

  it("submit stays unchanged: source app, new statuses accepted by the filter", async () => {
    const { id } = (await (await t.submit({ text: "from kit" })).json()) as { id: number };
    expect(await get(`/api/feedback/${id}`)).toMatchObject({ source: "app", status: "new", priority: null, labels: [], duplicate_of: null });
  });
});

describe("projects counts", () => {
  it("returns zero-filled counts by status per project in one statement", async () => {
    await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "acme-app", name: "Acme" }) });
    await seed([{ status: "new" }, { status: "new" }, { status: "ready" }, { project: 2, status: "done" }]);
    const zero = { new: 0, ready: 0, doing: 0, done: 0, wont_fix: 0, duplicate: 0 };
    const rows = await get("/api/projects");
    expect(rows.map((r: any) => [r.slug, r.counts])).toEqual([["demo", { ...zero, new: 2, ready: 1 }], ["acme-app", { ...zero, done: 1 }]]);
    await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "empty", name: "E" }) });
    expect((await get("/api/projects")).at(-1).counts).toEqual(zero);
    let n = 0;
    const counting = ((s: TemplateStringsArray, ...v: unknown[]) => { n++; return t.sql(s, ...v); }) as typeof t.sql;
    const { handle } = await import("../lib/api.ts");
    await handle(new Request("https://hub.test/api/projects", { headers: { authorization: "Bearer test-admin-token" } }), t.env, counting);
    expect(n).toBe(1);
  });
});

describe("retention", () => {
  it("duplicates expire with the other closed statuses", async () => {
    await seed([{ status: "duplicate" }, { status: "ready" }]);
    await t.db.query("update feedback set updated_at = now() - interval '181 days'");
    await t.submit({ text: "trigger cleanup" });
    expect((await t.db.query("select id::int as id from feedback order by id")).rows.map((r: any) => r.id)).toEqual([2, 3]);
  });
});
