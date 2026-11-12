// The owner's Telegram bot: messages about letters, and deciding them from the chat.
// - Every letter message has "Open in Postbox", "Won't fix" and "Next unread"; a reply to it becomes the decision for
//   the agent and moves the letter to Ready. Every change has an Undo button.
// - /next shows the oldest unread letter, so the owner can work through the inbox from the phone.
// Telegram calls POST /api/telegram with a secret header (set by POST /api/telegram/connect, derived from ADMIN_TOKEN),
// and only the chat in TELEGRAM_CHAT_ID is listened to. Texts are plain (no parse mode): nothing a tester typed can
// add formatting or links.
import type { Row, Sql } from "./api.ts";
import { hex, sha256, tokenOk } from "./secure.ts";

export type TgEnv = { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; ADMIN_TOKEN?: string };
const TEXT_MAX = 1500;
const KIND: Record<string, string> = { bug: "Bug", idea: "Idea", other: "Other" };
const STATUS: Record<string, string> = { new: "Unread", ready: "Ready for agent", doing: "In progress", done: "Done", wont_fix: "Won't fix", duplicate: "Duplicate" };
const STATUSES = Object.keys(STATUS);
const ID_IN_TEXT = /^📬 .*#(\d{1,9})\b/;

export const configured = (env: TgEnv) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

/** Calls the Bot API; throws on failure without the URL, which carries the bot token. */
export async function tg(env: TgEnv, method: string, body: object, fetchFn: typeof fetch): Promise<Row> {
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`telegram ${method} answered ${res.status}`);
  return (await res.json().catch(() => ({}))) as Row;
}

/** The secret Telegram sends back on every webhook call: derived from ADMIN_TOKEN, so there is nothing extra to keep. */
export const webhookSecret = async (adminToken: string) => hex(await sha256(`postbox telegram webhook|${adminToken}`));

export type LetterView = { id: number; project_name: string; kind: string; text: string; screen: string | null; platform: string | null };

/** The text of a letter message. `fresh` is a notification ("new letter"), else a letter shown with /next. */
export function letterText(l: LetterView, footer: string, dashboard: string, fresh: boolean): string {
  const text = l.text.length > TEXT_MAX ? `${l.text.slice(0, TEXT_MAX - 1)}…` : l.text;
  const where = [KIND[l.kind] ?? l.kind, l.screen, l.platform].filter(Boolean).join(" · ");
  return [
    `📬 ${l.project_name}: ${fresh ? "new letter" : "letter"} #${l.id}`, where, "", text, "", footer,
    "Reply to this message with what the agent should do: the letter goes to Ready with your words as the decision.",
    ...(linkButton(dashboard) ? [] : [`${dashboard}/#/?id=${l.id}`]),
  ].join("\n");
}

// Telegram refuses URL buttons that are not https (a local dashboard); the link then goes in the text.
const linkButton = (dashboard: string) => dashboard.startsWith("https://");
const open = (id: number, dashboard: string) => (linkButton(dashboard) ? [[{ text: "Open in Postbox", url: `${dashboard}/#/?id=${id}` }]] : []);
const NEXT = { text: "Next unread", callback_data: "n" };
export const letterKeyboard = (id: number, dashboard: string) => ({ inline_keyboard: [...open(id, dashboard), [{ text: "Won't fix", callback_data: `w:${id}` }, NEXT]] });
const undoKeyboard = (id: number, prev: string, dashboard: string) => ({ inline_keyboard: [...open(id, dashboard), [{ text: "Undo", callback_data: `u:${id}:${prev}` }, NEXT]] });

/** Sends a letter message; `footer` is the unread count line. */
export async function sendLetter(env: TgEnv, l: LetterView, footer: string, dashboard: string, fresh: boolean, fetchFn: typeof fetch) {
  await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text: letterText(l, footer, dashboard, fresh),
    reply_markup: letterKeyboard(l.id, dashboard), link_preview_options: { is_disabled: true },
  }, fetchFn);
}

const HELP = [
  "I tell you about new letters, and you can decide them here.",
  "• Reply to a letter's message with what the agent should do: it goes to Ready with your words as the decision.",
  "• Won't fix closes it. Undo takes any change back.",
  "• /next shows the oldest unread letter. Open in Postbox shows the photos and everything else.",
].join("\n");

/** Status (and the decision, when given) in one statement; returns the status before, or null when the letter is gone. */
async function setStatus(sql: Sql, id: number, status: string, note?: string): Promise<string | null> {
  const rows = await sql`with old as (select id, status from feedback where id = ${id})
    update feedback f set status = ${status},
      note = case when ${note !== undefined}::boolean then ${note ?? null}::text else f.note end,
      duplicate_of = case when ${status}::text <> 'duplicate' then null else f.duplicate_of end,
      updated_at = now()
    from old where f.id = old.id returning old.status as prev`;
  return rows[0]?.prev ?? null;
}

async function sendNext(env: TgEnv, sql: Sql, dashboard: string, fetchFn: typeof fetch) {
  const rows = await sql`select f.id::int as id, p.name as project_name, f.kind, f.text, f.screen, f.platform,
      (select count(*)::int from feedback where status = 'new') as unread
    from feedback f join projects p on p.id = f.project_id where f.status = 'new' order by f.id limit 1`;
  if (!rows.length) return tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: "All caught up: no unread letters." }, fetchFn);
  const more = rows[0].unread - 1;
  return sendLetter(env, rows[0] as LetterView, more ? `${more} more unread after this one` : "This is the last unread letter.", dashboard, false, fetchFn);
}

/** POST /api/telegram: one update from Telegram. Answers 200 for anything it ignores, so Telegram does not retry it. */
export async function telegramUpdate(req: Request, env: TgEnv, sql: Sql, maxText: number, fetchFn: typeof fetch): Promise<Response> {
  const ok = () => Response.json({ ok: true });
  if (!configured(env) || !env.ADMIN_TOKEN) return Response.json({ error: "not found" }, { status: 404 });
  if (!(await tokenOk(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await webhookSecret(env.ADMIN_TOKEN)))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let u: Row;
  try {
    u = await req.json();
  } catch {
    return ok();
  }
  const dashboard = new URL(req.url).origin;
  const mine = (chat: Row | undefined) => chat && String(chat.id) === String(env.TELEGRAM_CHAT_ID);

  const q = u.callback_query;
  if (q) {
    if (!mine(q.message?.chat)) return ok();
    const answer = (text: string) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text }, fetchFn);
    const data = String(q.data ?? "");
    const m = /^(w):(\d{1,9})$|^(u):(\d{1,9}):([a-z_]+)$|^(n)$/.exec(data);
    if (!m) { await answer("That button is from an older version."); return ok(); }
    if (m[6]) { await answer(""); await sendNext(env, sql, dashboard, fetchFn); return ok(); }
    const id = Number(m[2] ?? m[4]);
    const target = m[1] ? "wont_fix" : m[5];
    if (!STATUSES.includes(target)) { await answer("Unknown status."); return ok(); }
    // A duplicate needs the letter it points at, which Telegram cannot ask for.
    if (target === "duplicate") { await answer("Open it in Postbox to mark it a duplicate again."); return ok(); }
    const prev = await setStatus(sql, id, target);
    if (prev === null) { await answer(`#${id} no longer exists.`); return ok(); }
    const line = m[1] ? `✓ #${id}: Won't fix` : `↩ Undone: #${id} is ${STATUS[target]} again`;
    await answer(line);
    // The message keeps its text with the outcome added; Undo goes back to the status it had before.
    await tg(env, "editMessageText", {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: `${String(q.message.text ?? "").split("\n\n✓ ")[0].split("\n\n↩ ")[0]}\n\n${line}`,
      reply_markup: m[1] ? undoKeyboard(id, prev, dashboard) : letterKeyboard(id, dashboard), link_preview_options: { is_disabled: true },
    }, fetchFn);
    return ok();
  }

  const msg = u.message;
  if (!msg || !mine(msg.chat)) return ok();
  const say = (text: string, extra: object = {}) => tg(env, "sendMessage", { chat_id: msg.chat.id, text, reply_parameters: { message_id: msg.message_id }, ...extra }, fetchFn);
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  const replied = msg.reply_to_message;
  const id = replied?.from?.is_bot ? Number(ID_IN_TEXT.exec(String(replied.text ?? ""))?.[1] ?? NaN) : NaN;
  if (Number.isInteger(id)) {
    if (!text) { await say("Send the decision as text."); return ok(); }
    if (text.length > maxText) { await say(`That is ${text.length} characters; a decision can be at most ${maxText}.`); return ok(); }
    const prev = await setStatus(sql, id, "ready", text);
    if (prev === null) { await say(`#${id} no longer exists.`); return ok(); }
    const was = prev === "new" ? "" : ` (it was ${STATUS[prev] ?? prev})`;
    await say(`✓ #${id} is Ready for the agent${was}, with your reply as the decision.`, { reply_markup: undoKeyboard(id, prev, dashboard) });
    return ok();
  }
  if (/^\/?next\b/i.test(text)) { await sendNext(env, sql, dashboard, fetchFn); return ok(); }
  await say(replied ? `Reply to a letter's message (it starts with 📬) to decide that letter.\n\n${HELP}` : HELP);
  return ok();
}

/** POST /api/telegram/connect (admin): points the bot's webhook at this Postbox and sets its commands. */
export async function connectTelegram(req: Request, env: TgEnv, fetchFn: typeof fetch): Promise<Response> {
  if (!configured(env) || !env.ADMIN_TOKEN) return Response.json({ error: "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first" }, { status: 400 });
  const url = `${new URL(req.url).origin}/api/telegram`;
  await tg(env, "setWebhook", { url, secret_token: await webhookSecret(env.ADMIN_TOKEN), allowed_updates: ["message", "callback_query"] }, fetchFn);
  await tg(env, "setMyCommands", { commands: [{ command: "next", description: "The oldest unread letter" }, { command: "help", description: "How deciding here works" }] }, fetchFn);
  return Response.json({ url });
}
