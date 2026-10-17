import { beforeEach, describe, expect, it } from "vitest";
import { JPEG, PNG, TOKEN, setup } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });

describe("submit", () => {
  it("stores feedback and the image", async () => {
    const res = await t.submit({ kind: "bug", text: " button broken ", screen: "Home", platform: "ios", build: "12", screenshot: JPEG });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { id } = (await res.json()) as { id: number };
    expect([...t.store.keys()]).toEqual([`demo/${id}/0.jpg`]);
    const item = await (await t.admin(`/api/feedback/${id}`)).json();
    expect(item).toMatchObject({ id, project: "demo", kind: "bug", text: "button broken", status: "new", screen: "Home", attachment_count: 1, has_thumb: false, attachments: [{ position: 0, kind: "screenshot", bytes: Buffer.from(JPEG, "base64").length, content_type: "image/jpeg" }] });
    expect(item).not.toHaveProperty("screenshot_key");
    const shot = await t.admin(`/api/feedback/${id}/screenshot`);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await shot.arrayBuffer()).toString("base64")).toBe(JPEG);
  });

  it("accepts png without image fields", async () => {
    const { id } = (await (await t.submit({ text: "idea", kind: "idea", screenshot: PNG })).json()) as { id: number };
    expect(t.store.has(`demo/${id}/0.png`)).toBe(true);
    expect((await t.submit({ text: "plain" })).status).toBe(201);
  });

  it("rejects missing and wrong keys", async () => {
    expect((await t.call("/api/submit", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await t.submit({ text: "x" }, { "x-project-key": "nope" })).status).toBe(401);
  });

  it("rejects bad text, kind and oversize text", async () => {
    expect((await t.submit({ text: "x".repeat(4001) })).status).toBe(413);
    expect((await t.submit({ text: "  " })).status).toBe(400);
    expect((await t.submit({ text: "x", kind: "rant" })).status).toBe(400);
    expect((await t.submit({ text: "x", platform: "palm" })).status).toBe(400);
    expect((await t.call("/api/submit", { method: "POST", headers: { "x-project-key": t.key, "content-length": "8" }, body: "not json" })).status).toBe(400);
  });

  it("rejects oversize and non-image screenshots", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]).toString("base64");
    expect((await t.submit({ text: "x", screenshot: big })).status).toBe(413);
    expect((await t.submit({ text: "x", screenshot: Buffer.from("GIF89a....").toString("base64") })).status).toBe(415);
    expect((await t.submit({ text: "x", screenshot: "%%%not base64" })).status).toBe(400);
    expect((await t.db.query("select count(*)::int as n from feedback")).rows[0]).toEqual({ n: 0 });
  });

  it("rate limits per ip and device header", async () => {
    for (let i = 0; i < 20; i++) expect((await t.submit({ text: "x" }, { "x-device-id": "d1" })).status).toBe(201);
    expect((await t.submit({ text: "x" }, { "x-device-id": "d1" })).status).toBe(429);
    expect((await t.submit({ text: "x" }, { "x-device-id": "d2" })).status).toBe(201);
  });

  it("rate limits per project", async () => {
    await t.db.query("insert into submit_log (project_id, reporter_hash) select 1, 'h' || g from generate_series(1, 200) g");
    expect((await t.submit({ text: "x" })).status).toBe(429);
  });

  it("answers CORS preflight", async () => {
    const res = await t.call("/api/submit", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-project-key");
  });
});

describe("admin", () => {
  it("requires the bearer token", async () => {
    for (const path of ["/api/feedback", "/api/feedback/1", "/api/projects", "/api/feedback/1/screenshot"]) {
      expect((await t.call(path)).status).toBe(401);
      expect((await t.call(path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await t.call(path, { headers: { authorization: TOKEN } })).status).toBe(401);
    }
    expect((await t.call("/api/feedback/1", { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await t.call("/api/feedback", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("answers 500 when the token is not configured", async () => {
    const res = await t.call("/api/feedback", { headers: { authorization: "Bearer " } }, { ...t.env, ADMIN_TOKEN: undefined });
    expect(res.status).toBe(500);
  });

  it("lists with filters, order and cursor", async () => {
    await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "other", name: "Other" }) });
    const other = (await (await t.admin("/api/projects")).json()) as { slug: string; public_key: string }[];
    const k2 = other.find((p) => p.slug === "other")!.public_key;
    await t.submit({ text: "a", kind: "bug" });
    await t.submit({ text: "b", kind: "idea" });
    await t.submit({ text: "c", kind: "bug" }, { "x-project-key": k2 });
    await t.admin("/api/feedback/1", { method: "PATCH", body: JSON.stringify({ status: "done" }) });

    const get = async (q: string) => (await (await t.admin("/api/feedback" + q)).json()) as { items: { id: number }[]; next_cursor: string | null };
    expect((await get("")).items.map((i) => i.id)).toEqual([3, 2, 1]);
    expect((await get("?project=demo")).items.map((i) => i.id)).toEqual([2, 1]);
    expect((await get("?kind=bug")).items.map((i) => i.id)).toEqual([3, 1]);
    expect((await get("?status=done")).items.map((i) => i.id)).toEqual([1]);
    expect((await get("?project=demo&status=new&kind=idea")).items.map((i) => i.id)).toEqual([2]);
    const page = await get("?limit=2");
    expect(page.items.map((i) => i.id)).toEqual([3, 2]);
    expect(page.next_cursor).toBe("2");
    const next = await get("?limit=2&cursor=2");
    expect(next.items.map((i) => i.id)).toEqual([1]);
    expect(next.next_cursor).toBeNull();
    expect((await t.admin("/api/feedback?status=bogus")).status).toBe(400);
  });

  it("patches status and note independently", async () => {
    const { id } = (await (await t.submit({ text: "x" })).json()) as { id: number };
    const patch = (b: object) => t.admin(`/api/feedback/${id}`, { method: "PATCH", body: JSON.stringify(b) });
    expect(await (await patch({ status: "doing" })).json()).toMatchObject({ status: "doing", note: null });
    expect(await (await patch({ note: "looking" })).json()).toMatchObject({ status: "doing", note: "looking" });
    expect(await (await patch({ status: "done", note: null })).json()).toMatchObject({ status: "done", note: null });
    expect((await patch({ status: "bogus" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await t.admin("/api/feedback/999", { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status).toBe(404);
  });

  it("creates projects and rejects duplicates", async () => {
    const res = await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "web-1", name: "Web" }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { public_key: string }).public_key).toMatch(/^pbk_[0-9a-f]{48}$/);
    expect((await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "web-1", name: "Web" }) })).status).toBe(409);
    expect((await t.admin("/api/projects", { method: "POST", body: JSON.stringify({ slug: "Bad Slug", name: "x" }) })).status).toBe(400);
  });

  it("answers 404 when there is no screenshot", async () => {
    const { id } = (await (await t.submit({ text: "x" })).json()) as { id: number };
    expect((await t.admin(`/api/feedback/${id}/screenshot`)).status).toBe(404);
    expect((await t.admin(`/api/feedback/${id}/thumb`)).status).toBe(404);
    expect((await t.admin(`/api/feedback/${id}/attachments/0`)).status).toBe(404);
  });
});

it("sql constraints back up the code", async () => {
  await expect(t.db.query("insert into feedback (project_id, kind, text) values (1, 'bug', '')")).rejects.toThrow();
  await expect(t.db.query("insert into feedback (project_id, kind, text) values (1, 'rant', 'x')")).rejects.toThrow();
  await expect(t.db.query("insert into feedback (project_id, kind, text, status) values (1, 'bug', 'x', 'open')")).rejects.toThrow();
});

it("deletes handled feedback 180 days after it was closed, on the next submit", async () => {
  const ids = [];
  for (const text of ["old done", "old open", "recent done"]) ids.push(((await (await t.submit({ text })).json()) as { id: number }).id);
  await t.sql`update feedback set status = 'done', updated_at = now() - interval '181 days' where id = ${ids[0]}`;
  await t.sql`update feedback set updated_at = now() - interval '181 days' where id = ${ids[1]}`;
  await t.sql`update feedback set status = 'done' where id = ${ids[2]}`;
  await t.submit({ text: "trigger" });
  const left = (await t.sql`select id::int as id from feedback order by id`).map((r) => r.id);
  expect(left).toEqual([ids[1], ids[2], ids[2] + 1]);
});
