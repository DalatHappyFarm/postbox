// Tells the owner on Telegram that testers sent letters. Off unless both secrets are set (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
// One message per mailbox per quiet spell: a burst of letters (ten in twenty minutes is normal after a test session)
// sends the first one with the unread count, and the next message comes only after QUIET_MINUTES.
import type { Row, Sql } from "./api.ts";

export const QUIET_MINUTES = 10;
const TEXT_MAX = 300;
const KIND = { bug: "Bug", idea: "Idea", other: "Other" } as Record<string, string>;

export type NewLetter = { id: number; kind: string; text: string; screen: string | null; platform: string | null };

/** Plain text (no parse mode), so whatever a tester typed cannot change the formatting or add links. */
export function telegramText(mailbox: string, l: NewLetter, unread: number, dashboard: string): string {
  const text = l.text.length > TEXT_MAX ? `${l.text.slice(0, TEXT_MAX - 1)}…` : l.text;
  const where = [KIND[l.kind] ?? l.kind, l.screen, l.platform].filter(Boolean).join(" · ");
  const more = unread > 1 ? `${unread} unread letters in this mailbox` : "1 unread letter in this mailbox";
  return [`📬 ${mailbox}: new letter #${l.id}`, where, "", text, "", more, `${dashboard}/#/?id=${l.id}`].join("\n");
}

export async function notifyNewLetter(
  env: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string },
  sql: Sql, project: Row, letter: NewLetter, dashboard: string, fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  // Claim the slot in one statement, so two letters at the same moment send one message.
  const won = await sql`update projects set notified_at = now()
    where id = ${project.id} and (notified_at is null or notified_at < now() - make_interval(mins => ${QUIET_MINUTES}::int)) returning id`;
  if (!won.length) return;
  const [{ unread }] = await sql`select count(*)::int as unread from feedback where project_id = ${project.id} and status = 'new'`;
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: telegramText(project.name, letter, unread, dashboard), link_preview_options: { is_disabled: true } }),
  });
  // Never log the URL: it carries the bot token.
  if (!res.ok) throw new Error(`telegram answered ${res.status}`);
}
