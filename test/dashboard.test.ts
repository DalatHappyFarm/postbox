import { describe, expect, it } from "vitest";
import { appendItems, brief, briefMany, cleanToken, decodeHash, DEFAULT_STATE, encodeHash, firstLine, fitScale, groupByScreen, inView, knownLabels, labelError, listQuery, migrateToken, moreBadge, nextAfter, normalizeLabel,
  progress, relativeTime, resizeDims, searchId, shortcutAction, stateQuery, STATUS_LABEL, STATUS_VIEWS, stepId, thumbPath, undoGroups, undoStack, viewCount, viewStatus, zoomAt, clampView } from "../public/lib.js";

const item = { id: 7, project: "demo", kind: "bug", status: "new", text: "Crash on save", note: null, screen: "Home", app_version: "1.2", build: "34", platform: "ios", device: null, os: "18", url: "", created_at: "2026-10-16T10:00:00Z", attachment_count: 3, has_thumb: true, priority: null, labels: [] as string[] };

describe("dashboard helpers", () => {
  it("builds the list query with the new filters and skips empty ones", () => {
    expect(listQuery({ project: "demo", status: "new", cursor: "40" })).toBe("limit=50&project=demo&status=new&cursor=40");
    expect(listQuery()).toBe("limit=50");
    expect(listQuery({ status: "new,ready", q: " crash ", screen: "Home", build: "34", priority: "none", label: "ux", source: "web", sort: "priority" }))
      .toBe("limit=50&status=new%2Cready&q=crash&screen=Home&build=34&priority=none&label=ux&source=web&sort=priority");
    expect(listQuery({ priority: "0" })).toBe("limit=50&priority=0");
    expect(listQuery({ sort: "new" })).toBe("limit=50");
  });
  it("turns the status views into API comma lists, counts and membership", () => {
    expect(STATUS_VIEWS.map((v) => viewStatus(v.key))).toEqual(["new,ready,doing", "new", "ready", "doing", "done", "wont_fix", "duplicate", ""]);
    expect(viewStatus("nope")).toBe("new,ready,doing");
    const by = { new: 5, ready: 2, doing: 1, done: 10, wont_fix: 3, duplicate: 4 };
    expect([viewCount("open", by), viewCount("new", by), viewCount("all", by), viewCount("ready", {})]).toEqual([8, 5, 25, 0]);
    expect([inView("open", "ready"), inView("open", "done"), inView("new", "ready"), inView("all", "done")]).toEqual([true, false, false, true]);
    expect(stateQuery({ ...DEFAULT_STATE, project: "demo", status: "new", sort: "old" })).toBe("limit=50&project=demo&status=new&sort=old");
  });
  it("round-trips the filters, the open letter and triage through the URL hash", () => {
    expect(encodeHash(DEFAULT_STATE)).toBe("#/");
    const s = { ...DEFAULT_STATE, project: "acme-app", status: "new", screen: "Settings / Profile", q: "crash & burn", sort: "old", group: true, letter: 12, triage: true, priority: "none", label: "ux" };
    const h = encodeHash(s);
    expect(h).toBe("#/?project=acme-app&status=new&priority=none&label=ux&screen=Settings+%2F+Profile&q=crash+%26+burn&sort=old&group=1&triage=1&id=12");
    expect(decodeHash(h)).toEqual(s);
    expect(decodeHash("")).toEqual(DEFAULT_STATE);
    expect(decodeHash("#/feedback/9")).toEqual({ ...DEFAULT_STATE, letter: 9 });
    expect(decodeHash("#/?status=bogus&sort=zzz&priority=9&kind=x&source=y&id=-3")).toEqual(DEFAULT_STATE);
  });
  it("maps shortcut keys, including the g then i chord and priority keys 1-4", () => {
    const a = (k: string) => shortcutAction(k).action;
    expect(shortcutAction("j")).toEqual({ action: "next", pendingG: false });
    expect(["r", "w", "d", "s", "u", "e", "z", "l", "x", "t", "n", "/", "?", " ", "k", "Enter"].map(a))
      .toEqual(["ready", "wont", "dup", "skip", "unread", "done", "undo", "label", "select", "triage", "new", "search", "help", "viewer", "prev", "open"]);
    expect(["1", "2", "3", "4", "5", "0"].map(a)).toEqual(["priority:0", "priority:1", "priority:2", "priority:3", null, null]);
    expect(shortcutAction("g")).toEqual({ action: null, pendingG: true });
    expect(shortcutAction("i", true)).toEqual({ action: "allMail", pendingG: false });
    expect(shortcutAction("j", true)).toEqual({ action: null, pendingG: false });
  });
  it("picks the next letter in triage: same slot when the letter left the list, next one when it stays, wrapping", () => {
    const ids = [10, 11, 12, 13];
    expect(nextAfter(ids, 11, false)).toBe(12);
    expect(nextAfter(ids, 13, false)).toBe(10);
    expect(nextAfter(ids, 11, true)).toBe(12);
    expect(nextAfter(ids, 13, true)).toBe(10);
    expect(nextAfter([5], 5, false)).toBeNull();
    expect(nextAfter([5], 5, true)).toBeNull();
    expect(nextAfter(ids, 99, false)).toBe(10);
    expect(nextAfter([], 1, false)).toBeNull();
    expect([stepId(ids, 10, -1), stepId(ids, 12, 1), stepId(ids, 13, 1), stepId(ids, null, 1), stepId([], 1, 1)]).toEqual([10, 13, 13, 10, null]);
    expect(progress(12, 47)).toEqual({ done: 12, left: 35, pct: 26 });
    expect(progress(3, 0)).toEqual({ done: 3, left: 0, pct: 100 });
  });
  it("undoes in reverse order and groups equal old values for one bulk call", () => {
    const u = undoStack(2);
    u.push("a"); u.push("b"); u.push("c");
    expect([u.size, u.pop(), u.pop(), u.pop()]).toEqual([2, "c", "b", undefined]);
    const before = [{ id: 1, status: "new", priority: null }, { id: 2, status: "new", priority: null }, { id: 3, status: "doing", priority: 1 }];
    expect(undoGroups(before, { status: "ready" })).toEqual([
      { ids: [1, 2], prev: { status: "new", duplicate_of: null } },
      { ids: [3], prev: { status: "doing", duplicate_of: null } },
    ]);
    expect(undoGroups([{ id: 4, status: "new", labels: ["a"] }], { labels: ["a", "b"] })).toEqual([{ ids: [4], prev: { labels: ["a"] } }]);
    expect(undoGroups([{ id: 5, status: "new", duplicate_of: null }], { status: "duplicate", duplicate_of: 9 })[0].prev).toEqual({ status: "new", duplicate_of: null });
    expect(undoGroups([{ id: 6, status: "doing", duplicate_of: null }], { duplicate_of: 9 })[0].prev).toEqual({ status: "doing", duplicate_of: null });
  });
  it("normalizes and validates labels (1-32 chars of a-z 0-9 -, at most 8 per letter)", () => {
    expect([" Login Flow ", "UX_bug!", "--a--b--", "***", "x".repeat(40)].map(normalizeLabel)).toEqual(["login-flow", "ux-bug", "a-b", "", "x".repeat(32)]);
    expect(labelError("ok", [])).toBe("");
    expect(labelError("", [])).not.toBe("");
    expect(labelError("a", ["a"])).toMatch(/Already/);
    expect(labelError("n", Array.from({ length: 8 }, (_, k) => `l${k}`))).toMatch(/At most 8/);
    expect(knownLabels([{ labels: ["b", "a"] }, { labels: ["a"] }, {}])).toEqual(["a", "b"]);
  });
  it("computes the resized image size: long side 1600, never enlarged, aspect kept", () => {
    expect(resizeDims(4000, 3000)).toEqual({ w: 1600, h: 1200 });
    expect(resizeDims(1170, 2532)).toEqual({ w: 739, h: 1600 });
    expect(resizeDims(800, 600)).toEqual({ w: 800, h: 600 });
    expect(resizeDims(10000, 1)).toEqual({ w: 1600, h: 1 });
  });
  it("does the viewer maths: fit, zoom under the pointer, pan stays inside", () => {
    expect(fitScale(1000, 800, 500, 2000)).toBe(0.4);
    expect(fitScale(1000, 800, 400, 300)).toBe(1);
    const z = zoomAt({ s: 1, x: 0, y: 0 }, 2, 100, 50, 0.4);
    expect(z).toEqual({ s: 2, x: -100, y: -50 });
    expect(zoomAt({ s: 1, x: 0, y: 0 }, 0.1, 0, 0, 0.4).s).toBe(0.4);
    expect(zoomAt({ s: 7, x: 0, y: 0 }, 3, 0, 0, 0.4).s).toBe(8);
    expect(clampView({ s: 2, x: 9999, y: -9999 }, 1000, 800, 800, 600)).toEqual({ s: 2, x: 300, y: -200 });
    expect(clampView({ s: 1, x: 50, y: 50 }, 1000, 800, 800, 600)).toEqual({ s: 1, x: 0, y: 0 });
  });
  it("groups loaded letters by screen, biggest cluster first, unnamed last", () => {
    const g = groupByScreen([{ screen: "B" }, { screen: "A" }, { screen: "" }, { screen: "B" }, { screen: "A" }, { screen: "C" }]);
    expect(g.map((x) => [x.screen, x.items.length])).toEqual([["A", 2], ["B", 2], ["C", 1], ["", 1]]);
  });
  it("reads an id out of the duplicate picker search", () => {
    expect([searchId("12"), searchId(" #7 "), searchId("12a"), searchId("")]).toEqual([12, 7, null, null]);
  });
  it("formats ages", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const ago = (s: number) => relativeTime(new Date(now - s * 1000).toISOString(), now);
    expect(ago(20)).toBe("just now");
    expect(ago(5 * 60)).toBe("5 min ago");
    expect(ago(3 * 3600 + 100)).toBe("3 h ago");
    expect(ago(2 * 86400)).toBe("2 d ago");
    expect(ago(65 * 86400)).toBe("2 mo ago");
    expect(ago(400 * 86400)).toBe("1 y ago");
  });
  it("writes the brief with priority, labels, the decision and folded duplicates", () => {
    expect(brief(item)).toBe([
      "# Feedback #7", "", "- project: demo", "- kind: bug", "- status: new", "- screen: Home", "- build: 1.2 (34)", "- platform: ios", "- os: 18",
      "- created: 2026-10-16T10:00:00Z", "Photos: 3, run postbox show 7 to download them", "", "## Text", "", "Crash on save",
    ].join("\n"));
    const full = brief({ ...item, attachment_count: 0, note: "Fix it, add a test", priority: 0, labels: ["ux", "login"], duplicates: [{ id: 9, text: "Same crash" }] });
    expect(full).toContain("- priority: urgent\n- labels: ux, login\n- screen: Home");
    expect(full).toContain("## Decision for the agent\n\nFix it, add a test");
    expect(full).toContain("## Duplicates folded in\n\n- #9: Same crash");
    expect(full).not.toContain("Photos:");
  });
  it("writes one document for several letters, a single brief for one", () => {
    expect(briefMany([item])).toBe(brief(item));
    const two = briefMany([item, { ...item, id: 8, text: "Typo" }]);
    expect(two.startsWith("# Postbox brief: 2 letters\n\n# Feedback #7")).toBe(true);
    expect(two).toContain("Crash on save\n\n---\n\n# Feedback #8");
    expect(two.indexOf("#7")).toBeLessThan(two.indexOf("#8"));
  });
  it("appends the next page in the server's order without repeats", () => {
    expect(appendItems([{ id: 3 }, { id: 1 }], [{ id: 1 }, { id: 0 }]).map((i: { id: number }) => i.id)).toEqual([3, 1, 0]);
  });
  it("picks the list image: thumb, else first image, else none; badge counts the extra images", () => {
    expect(thumbPath({ id: 7, attachment_count: 2, has_thumb: true })).toBe("/api/feedback/7/thumb");
    expect(thumbPath({ id: 7, attachment_count: 1, has_thumb: false })).toBe("/api/feedback/7/attachments/0");
    expect(thumbPath({ id: 7, attachment_count: 0, has_thumb: false })).toBeNull();
    expect([0, 1, 2, 4].map((n) => moreBadge({ attachment_count: n }))).toEqual(["", "", "+1", "+3"]);
  });
  it("maps API statuses to the Postbox vocabulary", () => {
    expect(Object.values(STATUS_LABEL)).toEqual(["Unread", "Ready for agent", "In progress", "Done", "Won't fix", "Duplicate"]);
    expect(firstLine("  Crash on save\nmore")).toBe("Crash on save");
    expect(firstLine(null)).toBe("");
  });
  it("moves the old token key to the new one once", () => {
    const mem = (init: Record<string, string>) => { const d = { ...init }; return { d, getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => { d[k] = v; }, removeItem: (k: string) => { delete d[k]; } }; };
    const old = mem({ fh_admin_token: "t1" });
    expect(migrateToken(old)).toBe("t1");
    expect(old.d).toEqual({ postbox_admin_token: "t1" });
    expect(migrateToken(old)).toBe("t1");
    expect(migrateToken(mem({ postbox_admin_token: "new", fh_admin_token: "old" }))).toBe("new");
    expect(migrateToken(mem({}))).toBe("");
    expect(migrateToken({ getItem() { throw new Error("blocked"); } })).toBe("");
  });
});

describe("cleanToken", () => {
  it("accepts the token as pasted from an env file or with quotes", () => {
    const t = "a".repeat(64);
    for (const raw of [t, ` ${t}\n`, `"${t}"`, `'${t}'`, `ADMIN_TOKEN="${t}"`, `FH_ADMIN_TOKEN_PRODUCTION = '${t}'`]) expect(cleanToken(raw)).toBe(t);
    expect(cleanToken("")).toBe("");
  });
});
