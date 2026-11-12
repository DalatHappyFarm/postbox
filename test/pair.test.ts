import { describe, expect, it } from "vitest";
import { TOKEN, setup } from "./helpers.ts";

describe("sign in on a phone (pair codes)", () => {
  it("a code from the owner's computer gives a phone the token once; only its hash is stored", async () => {
    const t = await setup();
    const r = await t.admin("/api/pair", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    const { code, expires_at } = (await r.json()) as { code: string; expires_at: string };
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    const minutes = (Date.parse(expires_at) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(4); expect(minutes).toBeLessThanOrEqual(5);
    const stored = (await t.db.query("select code_hash from pair_codes")).rows as { code_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].code_hash).not.toContain(code);

    const claim = (c: unknown) => t.call("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: c }) });
    const ok = await claim(code);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ token: TOKEN });
    expect((await claim(code)).status).toBe(404); // once only
    expect((await t.db.query("select count(*)::int as n from pair_codes")).rows[0]).toEqual({ n: 0 });
  });

  it("refuses expired, unknown and malformed codes; making a code needs the admin token and clears old ones", async () => {
    const t = await setup();
    const { code } = (await (await t.admin("/api/pair", { method: "POST", body: "{}" })).json()) as { code: string };
    await t.db.query("update pair_codes set expires_at = now() - interval '1 second'");
    const claim = (body: string) => t.call("/api/pair/claim", { method: "POST", body });
    const expired = await claim(JSON.stringify({ code }));
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "this code has expired or was already used" });
    expect((await claim(JSON.stringify({ code: "0".repeat(32) }))).status).toBe(404);
    for (const body of ["nope", "{}", JSON.stringify({ code: "ABC" }), JSON.stringify({ code: "g".repeat(32) })]) expect((await claim(body)).status, body).toBe(400);
    expect((await t.call("/api/pair", { method: "POST", body: "{}" })).status).toBe(401);
    await t.db.query("insert into pair_codes values ('old', now() - interval '1 hour')");
    await t.admin("/api/pair", { method: "POST", body: "{}" });
    expect((await t.db.query("select count(*)::int as n from pair_codes where code_hash = 'old'")).rows[0]).toEqual({ n: 0 });
  });
});
