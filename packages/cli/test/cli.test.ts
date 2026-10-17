import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realDeps, run, type Deps } from "../src/index.js";

const item = {
  id: 42, project: "demo", kind: "bug", text: "Save button does nothing", status: "new", note: null,
  screen: "Settings", build: "77", app_version: "1.2.0", platform: "ios", device: "iPhone 15", os: "iOS 19",
  url: null, created_at: "2026-10-16T10:00:00Z", attachment_count: 3,
  attachments: [
    { position: 0, kind: "screenshot", bytes: 3, content_type: "image/png" },
    { position: 1, kind: "photo", bytes: 2, content_type: "image/jpeg" },
    { position: 2, kind: "photo", bytes: 1, content_type: "image/jpeg" },
  ],
};

function harness(handler: (url: string, init: RequestInit) => Response) {
  const dir = mkdtempSync(join(tmpdir(), "postbox-test-"));
  const out: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const d: Deps = {
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as typeof fetch,
    env: { POSTBOX_URL: "https://hub.test/", POSTBOX_TOKEN: "tok" },
    out: (l) => out.push(l),
    configPath: join(dir, "cfg", "config.json"),
    tmp: dir,
  };
  return { d, out, calls, dir };
}

describe("postbox", () => {
  it("show downloads every attachment and prints a markdown brief with the paths", async () => {
    const h = harness((url) => {
      const n = /attachments\/(\d)$/.exec(url)?.[1];
      return n ? new Response(new Uint8Array([Number(n) + 1, 9])) : Response.json(item);
    });
    await run(["show", "42"], h.d);
    const paths = [0, 1, 2].map((n) => join(h.dir, `postbox-42-${n}.${n === 0 ? "png" : "jpg"}`));
    paths.forEach((p, n) => expect(readFileSync(p)).toEqual(Buffer.from([n + 1, 9])));
    expect(h.out[0]).toBe(
      ["# Feedback #42", "", "- project: demo", "- kind: bug", "- status: new", "- screen: Settings", "- build: 1.2.0 (77)",
        "- platform: ios", "- device: iPhone 15", "- os: iOS 19", "- created: 2026-10-16T10:00:00Z", ...paths.map((p, n) => `- image ${n + 1}: ${p}`),
        "", "## Text", "", "Save button does nothing"].join("\n"));
    expect(h.calls.map((c) => c.url).sort()).toEqual(["", "/0", "/1", "/2"].map((x) => (x ? `https://hub.test/api/feedback/42/attachments${x}` : "https://hub.test/api/feedback/42")).sort());
    expect((h.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("show --json includes the attachments list and downloads nothing; no attachments means no downloads", async () => {
    const h = harness(() => Response.json(item));
    await run(["show", "42", "--json"], h.d);
    expect(JSON.parse(h.out[0]).attachments).toHaveLength(3);
    expect(h.calls).toHaveLength(1);
    const none = harness(() => Response.json({ ...item, attachment_count: 0, attachments: [] }));
    await run(["show", "42"], none.d);
    expect(none.calls).toHaveLength(1);
    expect(none.out[0]).not.toContain("image 1");
  });

  it("list passes filters and prints a table", async () => {
    const h = harness(() => Response.json({ items: [item], next_cursor: null }));
    await run(["list", "--project", "demo", "--status", "new"], h.d);
    expect(h.calls[0].url).toBe("https://hub.test/api/feedback?limit=200&project=demo&status=new");
    expect(h.out[0]).toContain("Save button does nothing");
    await run(["list", "--json"], h.d);
    expect(JSON.parse(h.out[1])).toEqual([item]);
  });

  it("done patches status and note; status validates", async () => {
    const h = harness(() => Response.json({ ...item, status: "done" }));
    await run(["done", "42", "--note", "fixed in 78"], h.d);
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ status: "done", note: "fixed in 78" });
    await expect(run(["status", "42", "open"], h.d)).rejects.toThrow("status must be");
    await run(["note", "42", "hello"], h.d);
    expect(JSON.parse(h.calls[1].init.body as string)).toEqual({ note: "hello" });
  });

  it("project add prints the key and surfaces api errors", async () => {
    const h = harness(() => Response.json({ public_key: "pbk_abc" }, { status: 201 }));
    await run(["project", "add", "web", "Web Site"], h.d);
    expect(h.out).toEqual(["pbk_abc"]);
    const bad = harness(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(run(["list"], bad.d)).rejects.toThrow("401 unauthorized");
  });

  it("login writes the config with mode 600 and it is used later", async () => {
    const h = harness(() => Response.json({ items: [], next_cursor: null }));
    h.d.env = {};
    await run(["login", "https://x.pages.dev", "secret"], h.d);
    expect(statSync(h.d.configPath).mode & 0o777).toBe(0o600);
    await run(["list"], h.d);
    expect(h.calls[0].url).toBe("https://x.pages.dev/api/feedback?limit=200");
    h.d.configPath = join(h.dir, "none.json");
    await expect(run(["list"], h.d)).rejects.toThrow("not configured");
  });

  it("copies the old ~/.config/fh config once, keeps mode 600 and leaves the old file", async () => {
    const home = mkdtempSync(join(tmpdir(), "postbox-home-"));
    vi.stubEnv("HOME", home);
    try {
      const old = join(home, ".config", "fh", "config.json");
      mkdirSync(join(home, ".config", "fh"), { recursive: true });
      writeFileSync(old, JSON.stringify({ url: "https://old.pages.dev", token: "oldtok" }) + "\n");
      chmodSync(old, 0o644);
      const h = harness(() => Response.json({ items: [], next_cursor: null }));
      h.d.env = {};
      h.d.configPath = realDeps().configPath;
      h.d.legacyConfigPath = realDeps().legacyConfigPath;
      expect(h.d.configPath).toBe(join(home, ".config", "postbox", "config.json"));
      await run(["list"], h.d);
      expect(h.calls[0].url).toBe("https://old.pages.dev/api/feedback?limit=200");
      expect(statSync(h.d.configPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(old, "utf8")).toContain("oldtok");
      writeFileSync(old, JSON.stringify({ url: "https://newer.pages.dev", token: "x" }));
      await run(["list"], h.d);
      expect(h.calls[1].url).toBe("https://old.pages.dev/api/feedback?limit=200");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
