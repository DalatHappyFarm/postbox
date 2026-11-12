import { describe, expect, it } from "vitest";
import { normalizeOrigin, originAllowed } from "../lib/origins.ts";
import { setup } from "./helpers.ts";

describe("normalizeOrigin", () => {
  it("lowercases, drops a trailing slash and default ports, keeps wildcards", () => {
    expect(["https://Shop.Example.com/", " http://localhost:5173 ", "https://example.com:443", "http://example.com:80", "https://*.example.com", "http://localhost:*", "https://a.b:8443"].map(normalizeOrigin))
      .toEqual(["https://shop.example.com", "http://localhost:5173", "https://example.com", "http://example.com", "https://*.example.com", "http://localhost:*", "https://a.b:8443"]);
  });
  it("refuses anything that is not scheme://host[:port]", () => {
    for (const bad of ["example.com", "ftp://example.com", "https://example.com/path", "https://*.com", "https://*", "*", "https://ex ample.com", "https://example.com:0", "https://example.com:70000", "https://ex*ample.com", "https://user@example.com", "null", ""])
      expect(normalizeOrigin(bad), bad).toBeNull();
  });
});

describe("originAllowed", () => {
  const list = ["https://shop.example.com", "https://*.preview.example.com", "http://localhost:*"];
  it("allows anything when the list is empty, and requests without an Origin header (apps, scripts)", () => {
    expect(originAllowed("https://evil.test", [])).toBe(true);
    expect(originAllowed(null, list)).toBe(true);
  });
  it("matches scheme, host and port exactly, subdomains for *. and any port for :*", () => {
    const yes = ["https://shop.example.com", "https://a.preview.example.com", "https://x.y.preview.example.com", "http://localhost:5173", "http://localhost"];
    const no = ["http://shop.example.com", "https://shop.example.com:8443", "https://preview.example.com", "https://badpreview.example.com", "https://shop.example.com.evil.test",
      "https://localhost:5173", "null", "https://example.com"];
    for (const o of yes) expect(originAllowed(o, list), o).toBe(true);
    for (const o of no) expect(originAllowed(o, list), o).toBe(false);
  });
});

describe("allowed origins on the API", () => {
  it("a mailbox with a list refuses other websites before the rate limit; apps without Origin still send", async () => {
    const t = await setup();
    const set = (body: unknown, slug = "demo") => t.admin(`/api/projects/${slug}`, { method: "PATCH", body: JSON.stringify(body) });
    expect((await t.submit({ text: "any site while the list is empty" }, { origin: "https://elsewhere.test" })).status).toBe(201);

    const r = await set({ allowed_origins: ["https://Shop.example.com/", "https://shop.example.com", "http://localhost:*"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ slug: "demo", allowed_origins: ["https://shop.example.com", "http://localhost:*"] });
    expect(((await (await t.admin("/api/projects")).json()) as any[])[0].allowed_origins).toEqual(["https://shop.example.com", "http://localhost:*"]);

    const refused = await t.submit({ text: "from another site" }, { origin: "https://elsewhere.test" });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*"); // the widget can read the reason
    expect(await refused.json()).toEqual({ error: "origin not allowed" });
    expect((await t.db.query("select count(*)::int as n from submit_log")).rows[0]).toEqual({ n: 1 }); // refused before the rate limit counts it
    expect((await t.submit({ text: "from the shop" }, { origin: "https://shop.example.com" })).status).toBe(201);
    expect((await t.submit({ text: "local dev" }, { origin: "http://localhost:5173" })).status).toBe(201);
    expect((await t.submit({ text: "the app" })).status).toBe(201);

    expect((await set({ allowed_origins: [] })).status).toBe(200);
    expect((await t.submit({ text: "open again" }, { origin: "https://elsewhere.test" })).status).toBe(201);
  });

  it("validates the list and the mailbox, and needs the admin token", async () => {
    const t = await setup();
    const set = (body: unknown, slug = "demo") => t.admin(`/api/projects/${slug}`, { method: "PATCH", body: JSON.stringify(body) });
    for (const body of [{}, { allowed_origins: "https://a.com" }, { allowed_origins: ["a.com"] }, { allowed_origins: [7] }, { allowed_origins: Array.from({ length: 21 }, (_, n) => `https://s${n}.com`) }])
      expect((await set(body)).status, JSON.stringify(body)).toBe(400);
    expect(await (await set({ allowed_origins: ["https://ok.com", "https://*.com"] })).json()).toEqual({ error: "invalid origin: https://*.com" });
    expect((await set({ allowed_origins: [] }, "nope")).status).toBe(404);
    expect((await t.call("/api/projects/demo", { method: "PATCH", body: "{}" })).status).toBe(401);
  });
});
