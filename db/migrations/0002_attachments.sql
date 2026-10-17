-- Several images per feedback (screenshot + photos) and a list thumbnail.
create table attachments (
  feedback_id bigint not null references feedback (id) on delete cascade,
  position smallint not null check (position >= 0),
  kind text not null check (kind in ('screenshot', 'photo')),
  r2_key text not null check (char_length(r2_key) <= 300),
  bytes int check (bytes >= 0), -- null for rows copied from screenshot_key (size unknown)
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  primary key (feedback_id, position)
);

alter table feedback add column thumb_key text check (char_length(thumb_key) <= 300);
alter table feedback add column attachment_count smallint not null default 0;

-- Existing screenshots become attachment 0. screenshot_key stays (read-only) for one release; a later migration drops it.
insert into attachments (feedback_id, position, kind, r2_key, content_type)
select id, 0, 'screenshot', screenshot_key, case when screenshot_key like '%.png' then 'image/png' else 'image/jpeg' end
from feedback where screenshot_key is not null;
update feedback set attachment_count = 1 where screenshot_key is not null;

-- MAX_TEXT is configurable now; the database keeps only a hard ceiling (same as lib/limits.ts).
alter table feedback drop constraint feedback_text_check;
alter table feedback add constraint feedback_text_check check (char_length(text) between 1 and 10000);
alter table feedback drop constraint feedback_note_check;
alter table feedback add constraint feedback_note_check check (char_length(note) <= 10000);
