import { beforeEach, describe, expect, it } from "vitest";
import { webhookSecret } from "../lib/telegram.ts";
import { TOKEN, setup } from "./helpers.ts";

const CHAT = 42;
let t: Awaited<ReturnType<typeof setup>>;
let secret: string;
beforeEach(async () => {
  t = await setup();
  Object.assign(t.env, { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: String(CHAT) });
  secret = await webhookSecret(TOKEN);
  for (const text of ["first letter", "1. Phần coaching rất OKE,\n2. Sửa BÀI TẬP", "third"]) await t.submit({ text, kind: "idea", platform: "web" });
  await t.settle();
  t.sent.length = 0;
});

const hook = (update: object, s = secret) =>
  t.call("/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": s, "content-type": "application/json" }, body: JSON.stringify(update) });
const letterMsg = (id: number, message_id = 500) => ({ message_id, chat: { id: CHAT }, from: { id: 999, is_bot: true }, text: `📬 Demo: new letter #${id}\nIdea · web\n\nfirst letter` });
const reply = (id: number, text: unknown, chat = CHAT) => ({ update_id: 1, message: { message_id: 600, chat: { id: chat }, from: { id: CHAT, is_bot: false }, text, reply_to_message: letterMsg(id) } });
const press = (data: string, chat = CHAT, message = letterMsg(1)) => ({ update_id: 2, callback_query: { id: "cb1", data, from: { id: CHAT }, message: { ...message, chat: { id: chat } } } });
const status = async (id: number) => ((await t.db.query(`select status, note from feedback where id = ${id}`)).rows[0] as { status: string; note: string | null });
const calls = (method: string) => t.sent.filter((s) => s.url.endsWith(`/${method}`)).map((s) => s.body);

describe("Telegram webhook", () => {
  it("answers only Telegram (the secret header) and only when the bot is configured", async () => {
    expect((await hook(reply(1, "x"), "wrong")).status).toBe(401);
    expect((await t.call("/api/telegram", { method: "POST", body: "{}" })).status).toBe(401);
    expect(await status(1)).toEqual({ status: "new", note: null });
    delete t.env.TELEGRAM_CHAT_ID;
    expect((await hook(reply(1, "x"))).status).toBe(404);
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // Telegram accepts A-Z a-z 0-9 _ - only
  });

  it("a reply to a letter's message becomes the decision and moves it to Ready; Undo puts the status back", async () => {
    const r = await hook(reply(2, "  Build a homework list with check-off; do 2 to 6, skip 1  "));
    expect(r.status).toBe(200);
    expect(await status(2)).toEqual({ status: "ready", note: "Build a homework list with check-off; do 2 to 6, skip 1" });
    const [said] = calls("sendMessage");
    expect(said).toMatchObject({ chat_id: CHAT, text: "✓ #2 is Ready for the agent, with your reply as the decision.", reply_parameters: { message_id: 600 } });
    expect(said.reply_markup.inline_keyboard.at(-1)).toEqual([{ text: "Undo", callback_data: "u:2:new" }, { text: "Next unread", callback_data: "n" }]);

    await hook(press("u:2:new", CHAT, { message_id: 700, chat: { id: CHAT }, from: { id: 999, is_bot: true }, text: said.text }));
    expect(await status(2)).toEqual({ status: "new", note: "Build a homework list with check-off; do 2 to 6, skip 1" }); // the words are kept
    expect(calls("answerCallbackQuery")[0]).toMatchObject({ callback_query_id: "cb1", text: "↩ Undone: #2 is Unread again" });
    expect(calls("editMessageText")[0].text).toBe(`${said.text}\n\n↩ Undone: #2 is Unread again`);
  });

  it("reopening a closed letter by reply says what it was; a letter that is gone, an empty or too long reply are explained", async () => {
    await t.db.query("update feedback set status = 'done' where id = 3");
    await hook(reply(3, "Do it again, the toast is back"));
    expect(calls("sendMessage")[0].text).toBe("✓ #3 is Ready for the agent (it was Done), with your reply as the decision.");
    await hook(reply(99, "x"));
    expect(calls("sendMessage")[1].text).toBe("#99 no longer exists.");
    await hook(reply(1, undefined));
    expect(calls("sendMessage")[2].text).toBe("Send the decision as text.");
    await hook(reply(1, "x".repeat(4001)));
    expect(calls("sendMessage")[3].text).toBe("That is 4001 characters; a decision can be at most 4000.");
    expect(await status(1)).toEqual({ status: "new", note: null });
  });

  it("Won't fix closes the letter and edits its message to show it, with Undo; Undo restores Unread", async () => {
    await hook(press("w:1"));
    expect(await status(1)).toMatchObject({ status: "wont_fix" });
    expect(calls("answerCallbackQuery")[0].text).toBe("✓ #1: Won't fix");
    const edit = calls("editMessageText")[0];
    expect(edit).toMatchObject({ chat_id: CHAT, message_id: 500, text: `${letterMsg(1).text}\n\n✓ #1: Won't fix` });
    expect(edit.reply_markup.inline_keyboard.at(-1)[0]).toEqual({ text: "Undo", callback_data: "u:1:new" });
    await hook(press("u:1:new", CHAT, { ...letterMsg(1), text: edit.text }));
    expect(await status(1)).toMatchObject({ status: "new" });
    expect(calls("editMessageText")[1].text).toBe(`${letterMsg(1).text}\n\n↩ Undone: #1 is Unread again`); // the earlier outcome line is replaced
    expect(calls("editMessageText")[1].reply_markup.inline_keyboard.at(-1)[0]).toEqual({ text: "Won't fix", callback_data: "w:1" });
  });

  it("Next unread and /next show the oldest unread letter with the count left; then all caught up", async () => {
    await hook(press("n"));
    const first = calls("sendMessage")[0];
    expect(first.text.split("\n").slice(0, 2)).toEqual(["📬 Demo: letter #1", "Idea · web"]);
    expect(first.text).toContain("2 more unread after this one");
    expect(first.reply_markup.inline_keyboard.at(-1)[0]).toEqual({ text: "Won't fix", callback_data: "w:1" });
    await t.db.query("update feedback set status = 'ready' where id in (1, 2)");
    await hook({ update_id: 3, message: { message_id: 1, chat: { id: CHAT }, text: "/next" } });
    expect(calls("sendMessage")[1].text).toContain("This is the last unread letter.");
    await t.db.query("update feedback set status = 'done'");
    await hook({ update_id: 4, message: { message_id: 2, chat: { id: CHAT }, text: "next" } });
    expect(calls("sendMessage")[2].text).toBe("All caught up: no unread letters.");
  });

  it("ignores every other chat, explains itself otherwise, and refuses stale or duplicate-restoring buttons", async () => {
    await hook(reply(1, "take over", 7));
    await hook(press("w:1", 7));
    expect(t.sent).toEqual([]);
    expect(await status(1)).toEqual({ status: "new", note: null });
    await hook({ update_id: 5, message: { message_id: 3, chat: { id: CHAT }, text: "/start" } });
    expect(calls("sendMessage")[0].text).toMatch(/^I tell you about new letters/);
    await hook({ update_id: 6, message: { message_id: 4, chat: { id: CHAT }, text: "hello", reply_to_message: { message_id: 9, from: { is_bot: true }, text: "I tell you about new letters" } } });
    expect(calls("sendMessage")[1].text).toMatch(/^Reply to a letter's message \(it starts with 📬\)/);
    await hook(press("delete:1"));
    expect(calls("answerCallbackQuery")[0].text).toBe("That button is from an older version.");
    await hook(press("u:1:duplicate"));
    expect(calls("answerCallbackQuery")[1].text).toBe("Open it in Postbox to mark it a duplicate again.");
    expect(await status(1)).toEqual({ status: "new", note: null });
    expect((await hook({ nonsense: true })).status).toBe(200);
  });
});

describe("connect", () => {
  it("points the webhook at this Postbox with the secret and sets the commands; admin only; needs the bot secrets", async () => {
    expect((await t.call("/api/telegram/connect", { method: "POST" })).status).toBe(401);
    const r = await t.admin("/api/telegram/connect", { method: "POST" });
    expect(await r.json()).toEqual({ url: "https://hub.test/api/telegram" });
    expect(calls("setWebhook")[0]).toEqual({ url: "https://hub.test/api/telegram", secret_token: secret, allowed_updates: ["message", "callback_query"] });
    expect(calls("setMyCommands")[0].commands.map((c: { command: string }) => c.command)).toEqual(["next", "help"]);
    delete t.env.TELEGRAM_BOT_TOKEN;
    expect((await t.admin("/api/telegram/connect", { method: "POST" })).status).toBe(400);
  });
});
