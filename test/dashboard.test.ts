import { describe, expect, it } from "vitest";
import { brief, cleanToken, firstLine, listQuery, matchesSearch, mergeItems, migrateToken, moreBadge, relativeTime, shortcutAction, statusStreams, STATUS_LABEL, stepIndex, tabStatus, TABS, thumbPath, unreadCounts } from "../public/lib.js";

describe("dashboard helpers", () => {
  it("builds the list query and skips empty filters", () => {
    expect(listQuery({ project: "demo", status: "new", cursor: "40" })).toBe("limit=50&project=demo&status=new&cursor=40");
    expect(listQuery()).toBe("limit=50");
  });
  it("splits the default filter into two status streams", () => {
    expect(statusStreams("active")).toEqual(["new", "doing"]);
    expect(statusStreams("done")).toEqual(["done"]);
    expect(statusStreams("")).toEqual([""]);
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
  it("writes the same brief as postbox show plus the photos line", () => {
    const item = { id: 7, project: "demo", kind: "bug", status: "new", text: "Crash on save", note: null, screen: "Home", app_version: "1.2", build: "34", platform: "ios", device: null, os: "18", url: "", created_at: "2026-10-16T10:00:00Z", attachment_count: 3, has_thumb: true };
    expect(brief(item)).toBe([
      "# Feedback #7", "", "- project: demo", "- kind: bug", "- status: new", "- screen: Home", "- build: 1.2 (34)", "- platform: ios", "- os: 18",
      "- created: 2026-10-16T10:00:00Z", "Photos: 3, run postbox show 7 to download them", "", "## Text", "", "Crash on save",
    ].join("\n"));
    expect(brief({ ...item, attachment_count: 0, note: "n" })).toContain("## Note\n\nn");
    expect(brief({ ...item, attachment_count: 0 })).not.toContain("Photos:");
  });
  it("merges streams newest first without duplicates", () => {
    expect(mergeItems([{ id: 3 }, { id: 1 }], [{ id: 2 }, { id: 3 }]).map((i: { id: number }) => i.id)).toEqual([3, 2, 1]);
  });
  it("picks the list image: thumb, else first image, else none; badge counts the extra images", () => {
    expect(thumbPath({ id: 7, attachment_count: 2, has_thumb: true })).toBe("/api/feedback/7/thumb");
    expect(thumbPath({ id: 7, attachment_count: 1, has_thumb: false })).toBe("/api/feedback/7/attachments/0");
    expect(thumbPath({ id: 7, attachment_count: 0, has_thumb: false })).toBeNull();
    expect([0, 1, 2, 4].map((n) => moreBadge({ attachment_count: n }))).toEqual(["", "", "+1", "+3"]);
  });
  it("maps API statuses to the Postbox vocabulary", () => {
    expect(Object.values(STATUS_LABEL)).toEqual(["Unread", "In progress", "Done", "Won't fix"]);
  });
  it("turns each quick filter tab into the API status filter; Open is two streams", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Open", "Unread", "In progress", "Done", "Won't fix", "All"]);
    expect(TABS.map((t) => tabStatus(t.key))).toEqual(["active", "new", "doing", "done", "wont_fix", ""]);
    expect(statusStreams(tabStatus("open"))).toEqual(["new", "doing"]);
    expect(tabStatus("nope")).toBe("active");
    expect(listQuery({ project: "demo", kind: "bug", status: tabStatus("unread") })).toBe("limit=50&project=demo&status=new&kind=bug");
  });
  it("searches loaded letters by every word", () => {
    const i = { text: "Crash on save\nsecond line", screen: "Home", project: "demo", note: null, kind: "bug", platform: "ios" };
    expect(matchesSearch(i, "")).toBe(true);
    expect(matchesSearch(i, "CRASH home")).toBe(true);
    expect(matchesSearch(i, "crash android")).toBe(false);
    expect(firstLine("  Crash on save\nmore")).toBe("Crash on save");
    expect(firstLine(null)).toBe("");
  });
  it("counts unread letters per mailbox", () => {
    const list = [{ project: "a", status: "new" }, { project: "a", status: "doing" }, { project: "b", status: "new" }, { project: "a", status: "new" }];
    expect(unreadCounts(list)).toEqual({ by: { a: 2, b: 1 }, total: 3 });
    expect(unreadCounts([])).toEqual({ by: {}, total: 0 });
  });
  it("maps shortcut keys, including the g then i chord", () => {
    expect(shortcutAction("j")).toEqual({ action: "next", pendingG: false });
    expect(shortcutAction("e").action).toBe("status:done");
    expect(shortcutAction("u").action).toBe("status:new");
    expect(shortcutAction("3").action).toBe("status:done");
    expect(shortcutAction("4").action).toBe("status:wont_fix");
    expect(shortcutAction("5").action).toBeNull();
    expect(shortcutAction("?").action).toBe("help");
    expect(shortcutAction("/").action).toBe("search");
    expect(shortcutAction("g")).toEqual({ action: null, pendingG: true });
    expect(shortcutAction("i", true)).toEqual({ action: "allMail", pendingG: false });
    expect(shortcutAction("j", true)).toEqual({ action: null, pendingG: false });
  });
  it("keeps the photo index inside the strip", () => {
    expect([stepIndex(0, 3, -1), stepIndex(1, 3, 1), stepIndex(2, 3, 1)]).toEqual([0, 2, 2]);
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
