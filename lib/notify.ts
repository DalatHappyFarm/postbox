// Tells the owner on Telegram that testers sent letters. Off unless both secrets are set (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
// One message per mailbox per quiet spell: a burst of letters (ten in twenty minutes is normal after a test session)
// sends the first one with the unread count, and the next message comes only after QUIET_MINUTES; "Next unread" in the
// message (lib/telegram.ts) walks through the rest.
import type { Row, Sql } from "./api.ts";
import { configured, sendLetter, type TgEnv } from "./telegram.ts";

export const QUIET_MINUTES = 10;

export type NewLetter = { id: number; kind: string; text: string; screen: string | null; platform: string | null };

export const unreadLine = (unread: number) => (unread > 1 ? `${unread} unread letters in this mailbox` : "1 unread letter in this mailbox");

export async function notifyNewLetter(env: TgEnv, sql: Sql, project: Row, letter: NewLetter, dashboard: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!configured(env)) return;
  // Claim the slot in one statement, so two letters at the same moment send one message.
  const won = await sql`update projects set notified_at = now()
    where id = ${project.id} and (notified_at is null or notified_at < now() - make_interval(mins => ${QUIET_MINUTES}::int)) returning id`;
  if (!won.length) return;
  const [{ unread }] = await sql`select count(*)::int as unread from feedback where project_id = ${project.id} and status = 'new'`;
  await sendLetter(env, { ...letter, project_name: project.name }, unreadLine(unread), dashboard, true, fetchFn);
}
