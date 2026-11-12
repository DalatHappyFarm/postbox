import { beforeEach, describe, expect, it } from "vitest";
import { JPEG, png, setup } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });
const del = (ids: unknown) => t.admin("/api/feedback/delete", { method: "POST", body: JSON.stringify({ ids }) });
const get = (id: number) => t.admin(`/api/feedback/${id}`);

describe("delete letters", () => {
  it("removes the rows and every image, thumb included", async () => {
    const a = (await (await t.submitForm({ text: "with photos" }, [{ field: "screenshot", bytes: png() }, { field: "photo", bytes: png(4) }, { field: "thumb", bytes: Buffer.from(JPEG, "base64") }])).json()) as { id: number };
    const b = (await (await t.submit({ text: "keep me" })).json()) as { id: number };
    expect(t.store.size).toBe(3);
    const r = await del([a.id, a.id]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: 1, back_to_unread: 0 });
    expect(t.store.size).toBe(0);
    expect((await get(a.id)).status).toBe(404);
    expect((await get(b.id)).status).toBe(200);
    expect((await t.db.query("select count(*)::int as n from attachments")).rows[0]).toEqual({ n: 0 });
  });

  it("letters that were duplicates of a deleted letter go back to Unread", async () => {
    for (const text of ["original", "copy", "other"]) await t.submit({ text });
    await t.admin("/api/feedback/2", { method: "PATCH", body: JSON.stringify({ duplicate_of: 1 }) });
    expect(await (await del([1])).json()).toEqual({ deleted: 1, back_to_unread: 1 });
    expect(await (await get(2)).json()).toMatchObject({ status: "new", duplicate_of: null });
    // deleting an original together with its duplicate frees nothing
    await t.admin("/api/feedback/3", { method: "PATCH", body: JSON.stringify({ duplicate_of: 2 }) });
    expect(await (await del([2, 3])).json()).toEqual({ deleted: 2, back_to_unread: 0 });
  });

  it("all ids must exist or nothing is deleted; validates; needs the admin token", async () => {
    await t.submitForm({ text: "x" }, [{ field: "photo", bytes: png() }]);
    expect((await del([1, 99])).status).toBe(404);
    expect((await get(1)).status).toBe(200);
    expect(t.store.size).toBe(1);
    for (const ids of [[], "1", [0], [1.5], ["1"], Array.from({ length: 201 }, (_, n) => n + 1)]) expect((await del(ids)).status, JSON.stringify(ids)).toBeGreaterThanOrEqual(400);
    expect((await t.call("/api/feedback/delete", { method: "POST", body: JSON.stringify({ ids: [1] }) })).status).toBe(401);
  });
});
