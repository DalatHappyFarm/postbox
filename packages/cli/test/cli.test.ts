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
      ["# Feedback #42", "", "- mailbox: demo", "- kind: bug", "- status: new", "- screen: Settings", "- build: 1.2.0 (77)",
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

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const full = { ...item, status: "ready", priority: 1, labels: ["ui", "perf"], source: "web", locale: "en-US", note: "Make it save; acceptance: toast shows", duplicates: [{ id: 43, text: "same bug" }] };
  const dup = { ...item, id: 43, text: "same bug, with photo", status: "duplicate", duplicate_of: 42, attachment_count: 1, attachments: [{ position: 0, kind: "photo", bytes: 2, content_type: "image/jpeg" }], duplicates: [] };
  const router = (calls: string[] = []) => (url: string, init: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://hub.test", "")}`);
    const m = /feedback\/(\d+)(?:\/attachments\/(\d))?$/.exec(url);
    if (m?.[2]) return new Response(new Uint8Array([Number(m[1]), Number(m[2])]));
    if (m?.[1] === "42") return Response.json(full);
    if (m?.[1] === "43") return Response.json(dup);
    return Response.json({ error: "not found" }, { status: 404 });
  };

  it("queue asks for ready letters sorted by priority and keeps its flags out of the way", async () => {
    const h = harness(() => Response.json({ items: [full], next_cursor: null, counts: {} }));
    await run(["queue", "--project", "demo", "--status", "new", "--sort", "old"], h.d);
    expect(h.calls[0].url).toBe("https://hub.test/api/feedback?limit=200&project=demo&status=ready&sort=priority");
    expect(h.out[0]).toMatch(/^\s*42\s+ready\s+high\s+bug\s+demo\s+Settings\s+Save button/);
    await run(["queue", "--json"], h.d);
    expect(JSON.parse(h.out[1])).toEqual([full]);
    const empty = harness(() => Response.json({ items: [] }));
    await run(["queue"], empty.d);
    expect(empty.out).toEqual(["queue is empty"]);
  });

  it("list passes every new filter", async () => {
    const h = harness(() => Response.json({ items: [] }));
    await run(["list", "--status", "new,ready", "--priority", "none", "--label", "ui", "--screen", "Home", "--source", "web", "--q", "crash", "--sort", "old"], h.d);
    expect(h.calls[0].url).toBe("https://hub.test/api/feedback?limit=200&status=new%2Cready&priority=none&label=ui&screen=Home&source=web&q=crash&sort=old");
  });

  it("brief folds duplicates in with their photos and lists every field, the decision included", async () => {
    const calls: string[] = [];
    const h = harness(router(calls));
    await run(["brief", "42"], h.d);
    const p = (id: number, n: number, e: string) => join(h.dir, `postbox-${id}-${n}.${e}`);
    expect(readFileSync(p(43, 0, "jpg"))).toEqual(Buffer.from([43, 0]));
    expect(h.out[0]).toBe([
      "# Feedback #42", "", "- mailbox: demo", "- kind: bug", "- priority: 1 (high)", "- labels: ui, perf", "- status: ready", "- screen: Settings", "- build: 1.2.0 (77)",
      "- platform: ios", "- device: iPhone 15", "- os: iOS 19", "- locale: en-US", "- source: web", "- created: 2026-10-16T10:00:00Z",
      `- image 1: ${p(42, 0, "png")}`, `- image 2: ${p(42, 1, "jpg")}`, `- image 3: ${p(42, 2, "jpg")}`,
      "", "## Text", "", "Save button does nothing", "", "## Decision for the agent", "", "Make it save; acceptance: toast shows",
      "", "## Duplicates (1)", "", "More reports of the same problem; read them as extra evidence.", "",
      "### Duplicate #43", "", "- mailbox: demo", "- kind: bug", "- status: duplicate", "- screen: Settings", "- build: 1.2.0 (77)", "- platform: ios", "- device: iPhone 15", "- os: iOS 19",
      "- created: 2026-10-16T10:00:00Z", `- image 1: ${p(43, 0, "jpg")}`, "", "## Text", "", "same bug, with photo",
    ].join("\n"));
    expect(calls.filter((c) => c.includes("/43")).length).toBe(2); // detail + its one photo
  });

  it("brief takes several ids, separates them, and --json has a stable shape", async () => {
    const h = harness(router());
    await run(["brief", "42", "43"], h.d);
    expect(h.out[0].split("\n\n---\n\n").map((x) => x.split("\n")[0])).toEqual(["# Feedback #42", "# Feedback #43"]);
    await run(["brief", "42", "43", "--json"], h.d);
    const j = JSON.parse(h.out[1]);
    expect(j.map((x: any) => x.id)).toEqual([42, 43]);
    expect(j[0].photos).toEqual([0, 1, 2].map((n) => join(h.dir, `postbox-42-${n}.${n === 0 ? "png" : "jpg"}`)));
    expect(j[0].duplicates[0]).toMatchObject({ id: 43, text: "same bug, with photo", photos: [join(h.dir, "postbox-43-0.jpg")] });
    expect(j[0]).toMatchObject({ priority: 1, labels: ["ui", "perf"], note: full.note, status: "ready" });
    await expect(run(["brief", "99"], h.d)).rejects.toThrow("404 not found");
  });

  it("claim patches ready to doing, then prints the brief; refuses a letter that is not ready", async () => {
    const calls: string[] = [];
    const h = harness(router(calls));
    await run(["claim", "42"], h.d);
    const patchIdx = calls.indexOf("PATCH /api/feedback/42");
    expect(patchIdx).toBeGreaterThan(0);
    expect(calls.slice(0, patchIdx)).toEqual(["GET /api/feedback/42"]); // status check before the change, downloads after
    expect(h.out[0]).toContain("## Decision for the agent");
    const notReady = harness(router());
    await expect(run(["claim", "43"], notReady.d)).rejects.toThrow("#43 is not ready (status: duplicate)");
    expect(notReady.calls.some((c) => c.init.method === "PATCH")).toBe(false);
  });

  it("add sends multipart with meta and photos after client-side checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "postbox-add-"));
    writeFileSync(join(dir, "a.png"), png);
    writeFileSync(join(dir, "b.txt"), "not an image");
    writeFileSync(join(dir, "big.png"), Buffer.concat([png, Buffer.alloc(100)]));
    const limits = { max_attachments: 2, max_image_bytes: 50, max_total_bytes: 15, max_text: 4000, image_types: [] };
    const posts: { init: RequestInit }[] = [];
    const h = harness((url, init) => {
      if (url.endsWith("/api/limits")) return Response.json(limits);
      posts.push({ init });
      return Response.json({ id: 7 }, { status: 201 });
    });
    await run(["add", "--project", "demo", "--text", "from a call", "--kind", "idea", "--photo", join(dir, "a.png"), "--json"], h.d);
    expect(JSON.parse(h.out[0])).toEqual({ id: 7 });
    const form = posts[0].init.body as FormData;
    expect(JSON.parse(form.get("meta") as string)).toEqual({ project: "demo", text: "from a call", kind: "idea" });
    expect(Buffer.from(await (form.get("photo") as File).arrayBuffer())).toEqual(png);
    expect((posts[0].init.headers as Record<string, string>)["content-type"]).toBeUndefined(); // fetch sets the multipart boundary
    expect(h.calls[1].url).toBe("https://hub.test/api/feedback");
    await run(["add", "--project", "demo", "--text", "plain"], h.d);
    expect(h.out[1]).toBe("#7 added");
    const before = posts.length;
    const add = (...photos: string[]) => run(["add", "--project", "demo", "--text", "x", ...photos.flatMap((p) => ["--photo", p])], h.d);
    await expect(add(join(dir, "b.txt"))).rejects.toThrow("only jpeg and png");
    await expect(add(join(dir, "big.png"))).rejects.toThrow("larger than 50 bytes");
    await expect(add(join(dir, "a.png"), join(dir, "a.png"), join(dir, "a.png"))).rejects.toThrow("at most 2 photos");
    await expect(add(join(dir, "a.png"), join(dir, "a.png"))).rejects.toThrow("together");
    await expect(add(join(dir, "missing.png"))).rejects.toThrow("cannot read");
    await expect(run(["add", "--project", "demo"], h.d)).rejects.toThrow("needs --project");
    expect(posts.length).toBe(before); // nothing uploaded after a failed check
  });

  it("status accepts ready and refuses duplicate", async () => {
    const h = harness(() => Response.json({ ...item, status: "ready" }));
    await run(["status", "42", "ready"], h.d);
    expect(h.out[0]).toBe("#42 -> ready");
    await expect(run(["status", "42", "duplicate"], h.d)).rejects.toThrow("status must be");
  });
});
