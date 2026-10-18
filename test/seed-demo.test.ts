import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { handle } from "../lib/api.ts";
import { stripJpeg } from "../lib/jpeg.ts";
import { COUNT, makeJpeg, makePng, plan, seed } from "../scripts/seed-demo.ts";
import { TOKEN, setup } from "./helpers.ts";

describe("seed-demo", () => {
  it("plans 120 neutral letters, deterministic, with the mix the UI needs", () => {
    const a = plan();
    expect(a).toHaveLength(COUNT);
    expect(plan()).toEqual(a);
    expect(a.filter((p) => p.photos).length).toBeGreaterThan(40);
    expect(a.filter((p) => p.photos).length).toBeLessThan(80);
    expect(a.filter((p) => p.dupOf !== null).length).toBeGreaterThanOrEqual(8);
    for (const p of a.filter((p) => p.dupOf !== null)) expect(a[p.dupOf!].dupOf).toBeNull();
    expect(new Set(a.map((p) => p.status))).toEqual(new Set(["new", "ready", "doing", "done", "wont_fix", "duplicate"]));
    expect(new Set(a.map((p) => p.priority))).toEqual(new Set([null, 0, 1, 2, 3]));
    expect(a.filter((p) => p.status === "ready").every((p) => p.note)).toBe(true);
  });

  it("generates a valid PNG and a JPEG the server's stripper accepts", () => {
    const png = makePng(4, 4, () => [1, 2, 3]);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpg = makeJpeg(24, 16, (x, y) => x * 40 + y * 20);
    expect(stripJpeg(jpg).length).toBe(jpg.length); // nothing to strip, structure walks cleanly to EOI
  });

  it("seeds 120 letters through the admin API into an empty database, twice safe for the project", async () => {
    const t = await setup(); // already has a `demo` project: the 409 is fine
    const fetchLike = (async (url: string, init: RequestInit = {}) => {
      const req = new Request(url, init);
      const raw = new Uint8Array(await req.arrayBuffer());
      const headers = new Headers(req.headers);
      headers.set("content-length", String(raw.length));
      return handle(new Request(url, { method: init.method, headers, body: raw.length ? (raw as BodyInit) : undefined }), t.env, t.sql);
    }) as typeof fetch;
    const r = await seed({ url: "https://hub.test/", token: TOKEN, fetch: fetchLike });
    expect(r.count).toBe(120);
    const q = async (sql: string) => (await t.db.query(sql)).rows as { n: number }[];
    expect((await q("select count(*)::int n from feedback"))[0].n).toBe(120);
    expect((await q("select count(*)::int n from feedback where source = 'web'"))[0].n).toBe(120);
    expect((await q("select count(*)::int n from feedback where attachment_count > 0"))[0].n).toBe(r.withPhotos);
    expect((await q("select count(*)::int n from feedback where status = 'duplicate' and duplicate_of is not null"))[0].n).toBe(r.duplicates);
    expect((await q("select count(*)::int n from feedback where status = 'ready' and note is null"))[0].n).toBe(0);
    expect(t.store.size).toBeGreaterThan(r.withPhotos);
    const bad = await seed({ url: "https://hub.test", token: "wrong", fetch: fetchLike }).catch((e: Error) => e.message);
    expect(bad).toContain("401");
    expect(String(bad)).not.toContain("wrong");
  }, 60_000);

  it("the command refuses without --yes and never prints the token", () => {
    const run = (args: string[]) => spawnSync(process.execPath, [new URL("../scripts/seed-demo.ts", import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, POSTBOX_URL: "http://127.0.0.1:9", POSTBOX_TOKEN: "super-secret-token" }, encoding: "utf8" });
    const noYes = run([]);
    expect(noYes.status).toBe(1);
    expect(noYes.stderr).toContain("--yes");
    expect(noYes.stdout + noYes.stderr).not.toContain("super-secret-token");
    const noEnv = spawnSync(process.execPath, [new URL("../scripts/seed-demo.ts", import.meta.url).pathname, "--yes"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(noEnv.status).toBe(1);
    expect(noEnv.stderr).toContain("POSTBOX_URL");
  });
});
