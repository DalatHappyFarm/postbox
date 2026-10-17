# Postbox: rename, redesign and open source (2026-10-17)

Decisions: Feedback Hub became **Postbox**, "the place where letters arrive"; it is open source under the GitHub organisation DalatHappyFarm (https://github.com/DalatHappyFarm).
The brand is charcoal, paper, signal blue, tan wood and field green, with a Da Lat touch (pine hills, mist, a wooden farm mailbox whose blue flag rises when a letter arrives).
Until the final logo exists the UI uses a placeholder inline SVG mailbox.

## 1. Names

| Thing | Before | After |
|---|---|---|
| Product | Feedback Hub | Postbox |
| Root package | `feedback-hub` | `postbox` |
| React Native kit | `feedback-kit` | `@dalathappyfarm/postbox-react-native` |
| CLI package and command | `@feedback-hub/cli`, `fh` | `@dalathappyfarm/postbox-cli`, `postbox` |
| CLI env and config | `FH_URL`, `FH_TOKEN`, `~/.config/fh/config.json` | `POSTBOX_URL`, `POSTBOX_TOKEN`, `~/.config/postbox/config.json` (the old file is copied once and kept) |
| New project keys | `fhk_...` | `pbk_...` (existing keys keep working: a key is any random string) |
| Dashboard storage key | `fh_admin_token` | `postbox_admin_token` (read the old one once) |

Not renamed, on purpose, because live deployments point at them: the Cloudflare Pages project `feedback-hub`, the R2 buckets `feedback-hub-shots*` and the Neon project.
A self-hoster picks their own names; `wrangler.toml` says where.

## 2. Vocabulary in the UI

| Concept | UI word |
|---|---|
| Feedback item | Letter |
| Project | Mailbox |
| Status new | Unread |
| Status doing | In progress |
| Status done | Done |
| Status wont_fix | Won't fix |
| Attachments | Photos |

The API and database keep their technical names (feedback, project, status values) so clients do not break.

## 3. Open source checklist

- MIT `LICENSE` at the root and in each package.
- README written for a self-hoster: what Postbox is, a screenshot, quick start (Neon or any Postgres, Cloudflare Pages and R2), configuration table, the client kit, the CLI, security model, privacy and retention, roadmap.
- `SECURITY.md` (report privately, what is in scope), `CONTRIBUTING.md` (short).
- No owner-specific values in tracked files: URLs of a private deployment, project keys, account names and app-specific notes are removed or generalised.
- Secret scan of the whole history before the first push to the organisation.
