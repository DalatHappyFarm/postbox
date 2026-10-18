# Triage at scale: spec (2026-10-17)

Goal: one person can work through 100 or more letters for a project quickly and well, decide what each one needs, and hand the decided ones to a coding agent.
Feedback is input for an agent; the owner stands in the middle and makes the decision (human in the loop).
This phase is manual on both sides of the owner: letters come from apps or are typed in by hand, and an agent picks up decided work through the CLI; automation comes in a later phase.

## 1. The workflow it must support

1. **Collect**: letters arrive from apps; the owner can also add one by hand on the web (from a chat message, an email, a call, a screenshot someone sent), with photos pasted from the clipboard or dropped in.
2. **Triage** (the core loop, keyboard first): open the oldest unread letter, look at its photos large, then decide in one key: ready for the agent (with an instruction), won't fix, duplicate of another letter, or keep for later; the view moves to the next letter automatically.
3. **Group**: see where letters cluster (by screen, by build, by kind, by label) and act on a group at once (select many, set status, priority or label together).
4. **Hand off**: the decided letters ("Ready") form the agent's queue; the agent claims one, works, and marks it done with a note; the owner sees progress.
5. **Review**: the owner checks what the agent finished, reopens if needed.

## 2. Data changes (migration 0003, additive)

- `status` gains `ready` (decided, waiting for the agent) and `duplicate`; the full set is `new, ready, doing, done, wont_fix, duplicate`.
- `priority smallint null check (priority between 0 and 3)`: 0 urgent, 1 high, 2 normal, 3 low; null means not set.
- `labels text[] not null default '{}'`, each label 1 to 32 characters, lower case letters, digits and dashes, at most 8 per letter.
- `duplicate_of bigint null references feedback(id) on delete set null`; setting it also sets status `duplicate`; a letter cannot point to itself or to a letter of another project.
- `source text not null default 'app' check (source in ('app', 'web'))`; letters added on the web have `web`.
- `note` keeps its column and becomes **"Decision for the agent"** in the UI: what the owner wants done, acceptance criteria; it is part of every brief.
- Indexes for the new filters: `(project_id, status, priority)`, a GIN index on `labels`, and a trigram or plain `lower(text)` index is NOT needed yet (ILIKE over a few thousand rows is fine; mark it with a ponytail comment).

UI words: Unread (new), Ready for agent (ready), In progress (doing), Done, Won't fix, Duplicate.

## 3. API changes (admin token unless noted)

- `GET /api/feedback` gains filters `q` (case-insensitive text search on text and note), `screen`, `build`, `priority` (0-3 or `none`), `label`, `source`, `status` accepting a comma list (`new,ready`), and `sort` (`new` default newest first, `old` oldest first, `priority` then oldest); the response adds `counts`: `{ status: {new: n, ready: n, ...}, screen: [{screen, n}] top 20 }` computed for the same project, kind and search filters (not the status filter), so the sidebar shows real numbers without loading every letter.
- `GET /api/feedback/:id` adds `priority, labels, duplicate_of, source`, `duplicates: [{id, text first line}]` (letters pointing at this one) and `neighbours: {prev, next}` ids within the current filter when `?ctx=` carries the list query (optional; the dashboard can also compute it client-side, decide in the build).
- `PATCH /api/feedback/:id` accepts `status, note, priority, labels, duplicate_of` (validated as in section 2).
- `POST /api/feedback/bulk` `{ ids: [...] (max 200), patch: { status?, priority?, labels_add?, labels_remove? } }` in one statement; returns the updated count.
- `POST /api/feedback` adds a letter by hand: multipart, same fields and limits as `/api/submit` (`meta` JSON plus `photo` files plus optional `thumb`), with `project` slug in `meta`, `source` = `web`; no project key and no rate limit (admin only), same magic-byte and JPEG metadata rules.
- `GET /api/projects` adds per-project `counts` by status (one grouped query).

## 4. Dashboard (owner)

Principles: keyboard first; one primary decision per letter; never lose context (position, filters, scroll survive actions and reloads via the URL hash); show the photo big, because most letters are understood from the picture; progress is visible ("12 of 47 unread left"); every action is undoable for a few seconds (toast with Undo).

- **Layout** (desktop): left rail with mailboxes and their counts, then facets for the current mailbox: Status (with counts), Priority, Screen (top screens with counts), Label, Source; centre list; right reading pane. Phone keeps list then letter.
- **Triage mode** (`t` or a "Start triage" button): the reading pane takes the main area with the photo large on the left and text, context and the decision controls on the right; actions advance to the next letter in the filter automatically; a progress bar shows done/total for the session.
- **Decision controls** with keys: `r` Ready for agent (focuses the decision box first if it is empty), `w` Won't fix, `d` Duplicate of (a picker that searches letters in the same mailbox by text or #id), `1`-`4` priority urgent to low, `l` add label (autocomplete from existing labels), `s` skip, `u` back to unread, `e` done; `z` or the toast's Undo reverts the last action.
- **Photos**: the reading pane shows the first photo large (fit to the pane, never a small thumbnail), a strip of the rest; the viewer opens on click or `space`: fit, 100 percent, zoom with wheel or `+`/`-`, drag to pan, arrows between photos, the letter's text and context in a side panel, `Esc` closes; screenshots of phones keep their tall ratio (no cropping).
- **List**: dense rows with the thumbnail at a readable size, first line, mailbox, screen, build, priority marker, labels, age, photo count; multi-select with `x` and shift-click; a bulk bar (status, priority, label, duplicate of) appears when anything is selected; sort selector (newest, oldest, priority); server search box (`/`).
- **Group by screen** toggle: the list shows sections per screen with counts, so clusters stand out.
- **New letter** (`n` or a "+ New letter" button): a dialog with mailbox, kind, text, screen, build, platform, device (optional fields collapsed), photos by paste (Cmd+V anywhere in the dialog), drop or file picker, client-side resize to 1600 px JPEG like the kit, preview with remove; saves through `POST /api/feedback` and opens the new letter.
- **Hand off**: "Copy for agent" on one letter, and on a selection "Copy brief for N letters" (one Markdown document); "Send to agent queue" sets the selected letters to Ready.
- **States**: loading skeletons, empty states that say what to do next, errors with a retry.
- **Accessibility and quality bars**: WCAG AA in light and dark, visible focus, all actions reachable by keyboard and by pointer, reduced motion, no horizontal scroll at 1440, 1280, 768, 390; the HTML, CSS and JS together stay small (target under 120 KB uncompressed), no framework, no build step, strict CSP kept.

## 5. Agent experience (CLI and briefs)

The agent works only through the CLI and the brief; both must be predictable and complete.

- `postbox queue [--project slug] [--json]`: letters in Ready, highest priority then oldest.
- `postbox claim <id>`: sets In progress and prints the brief (fails clearly if the letter is not Ready).
- `postbox show <id> [--json]` and `postbox brief <id...> [--json]`: one Markdown document per letter or for several, each with: id, mailbox, kind, priority, labels, status, screen, build, platform, device, OS, locale, created, the text, **the owner's decision**, duplicates folded in (their texts and photo paths, because more reports of the same problem are more evidence), and every photo downloaded to the temp folder with its path.
- `postbox done <id> --note "..."`, `postbox status <id> <status>`, `postbox note <id> "..."` as today; `postbox add --project slug --text "..." [--photo path ...]` adds a letter from the terminal.
- `--json` everywhere returns stable, documented shapes (documented in `docs/agent-guide.md`).
- `docs/agent-guide.md`: the loop for any coding agent (queue, claim, read the decision, fix, verify, done with a note saying what changed and how it was verified), rules (never set Ready itself, never close a letter without a note), and example commands.

## 6. Demo data

`scripts/seed-demo.ts` creates a `demo` mailbox with 120 neutral letters (mixed kinds, screens, builds, priorities, labels, some duplicates, about half with photos generated as simple images) through the admin API, so the UI can be judged at the scale it is built for; it refuses to run against a URL unless `--yes` is given.

## 7. Review

The owner reviews on the staging deployment (seeded with the demo data) before anything reaches production.
