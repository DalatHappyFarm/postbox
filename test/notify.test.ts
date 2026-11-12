import { describe, expect, it, vi } from "vitest";
import { QUIET_MINUTES } from "../lib/notify.ts";
import { letterKeyboard, letterText } from "../lib/telegram.ts";
import { setup } from "./helpers.ts";

const TG = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };

describe("letter messages", () => {
  const l = { id: 24, project_name: "Scar", kind: "bug", text: "Nút Lưu không chạy", screen: "/bao-cao", platform: "web" };
  it("name the mailbox, the letter, where it came from, the count line and how to decide by replying", () => {
    expect(letterText(l, "3 unread letters in this mailbox", "https://pb.test", true).split("\n")).toEqual([
      "📬 Scar: new letter #24", "Bug · /bao-cao · web", "", "Nút Lưu không chạy", "", "3 unread letters in this mailbox",
      "Reply to this message with what the agent should do: the letter goes to Ready with your words as the decision."]);
    expect(letterText(l, "x", "https://pb.test", false).split("\n")[0]).toBe("📬 Scar: letter #24");
    const long = letterText({ ...l, kind: "idea", text: "x".repeat(2000), screen: null, platform: null }, "", "https://pb.test", true).split("\n");
    expect(long[1]).toBe("Idea");
    expect(long[3]).toHaveLength(1500);
  });
  it("carry Open, Won't fix and Next unread; a dashboard without https gets the link in the text instead", () => {
    expect(letterKeyboard(24, "https://pb.test")).toEqual({ inline_keyboard: [[{ text: "Open in Postbox", url: "https://pb.test/#/?id=24" }], [{ text: "Won't fix", callback_data: "w:24" }, { text: "Next unread", callback_data: "n" }]] });
    expect(letterKeyboard(24, "http://localhost:8788").inline_keyboard).toHaveLength(1);
    expect(letterText(l, "x", "http://localhost:8788", true)).toContain("http://localhost:8788/#/?id=24");
  });
});

describe("notifications on submit", () => {
  it("sends one Telegram message for the first letter after a quiet spell, with the unread count, after the response", async () => {
    const t = await setup();
    t.env.TELEGRAM_BOT_TOKEN = TG.TELEGRAM_BOT_TOKEN;
    t.env.TELEGRAM_CHAT_ID = TG.TELEGRAM_CHAT_ID;
    expect((await t.submit({ kind: "bug", text: "first", screen: "Home", platform: "ios" })).status).toBe(201);
    await t.submit({ text: "second, same burst" });
    await t.settle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(t.sent[0].body).toMatchObject({ chat_id: "42", link_preview_options: { is_disabled: true }, reply_markup: letterKeyboard(1, "https://hub.test") });
    expect(t.sent[0].body).not.toHaveProperty("parse_mode");
    expect(t.sent[0].body.text).toContain("📬 Demo: new letter #1\nBug · Home · ios");

    // after the quiet spell the next letter is announced again, with everything still unread
    await t.db.query(`update projects set notified_at = now() - interval '${QUIET_MINUTES + 1} minutes'`);
    await t.submit({ text: "third, later" });
    await t.settle();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1].body.text).toContain("new letter #3");
    expect(t.sent[1].body.text).toContain("3 unread letters in this mailbox");
  });

  it("stays silent without the secrets, for letters added by hand, and for refused submits", async () => {
    const t = await setup();
    await t.submit({ text: "no secrets" });
    t.env.TELEGRAM_BOT_TOKEN = TG.TELEGRAM_BOT_TOKEN;
    t.env.TELEGRAM_CHAT_ID = TG.TELEGRAM_CHAT_ID;
    const form = new FormData();
    form.set("meta", JSON.stringify({ project: "demo", text: "added by the owner" }));
    const req = new Request("https://hub.test/x", { method: "POST", body: form });
    const raw = new Uint8Array(await req.arrayBuffer());
    const headers = { authorization: "Bearer test-admin-token", "content-type": req.headers.get("content-type")!, "content-length": String(raw.length) };
    expect((await t.call("/api/feedback", { method: "POST", headers, body: raw as BodyInit })).status).toBe(201);
    expect((await t.submit({ text: "x", kind: "rant" })).status).toBe(400);
    await t.settle();
    expect(t.sent).toEqual([]);
  });

  it("a Telegram failure never fails the submit and is logged without the token", async () => {
    const t = await setup();
    Object.assign(t.env, TG);
    t.net.reply = () => new Response("bad", { status: 401 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await t.submit({ text: "still stored" })).status).toBe(201);
    await t.settle();
    expect(log).toHaveBeenCalledWith("notify failed:", "telegram sendMessage answered 401");
    expect(JSON.stringify(log.mock.calls)).not.toContain("123:abc");
    log.mockRestore();
  });
});
