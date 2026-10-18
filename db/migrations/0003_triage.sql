-- Triage at scale: decision statuses, priority, labels, duplicates, source (docs/triage-spec.md section 2). Additive.
alter table feedback drop constraint feedback_status_check;
alter table feedback add constraint feedback_status_check check (status in ('new', 'ready', 'doing', 'done', 'wont_fix', 'duplicate'));

alter table feedback add column priority smallint check (priority between 0 and 3); -- 0 urgent, 1 high, 2 normal, 3 low, null not set
alter table feedback add column labels text[] not null default '{}';
-- Each label 1 to 32 of a-z 0-9 dash (no comma, so a joined string can be matched), at most 8 per letter.
alter table feedback add constraint feedback_labels_check check (
  cardinality(labels) <= 8 and (cardinality(labels) = 0 or array_to_string(labels, ',') ~ '^[a-z0-9-]{1,32}(,[a-z0-9-]{1,32})*$'));

alter table feedback add column duplicate_of bigint references feedback (id) on delete set null;
alter table feedback add constraint feedback_duplicate_self_check check (duplicate_of is null or duplicate_of <> id);

-- Backstop for the API rule: a letter can only be a duplicate of a letter in the same project.
create function feedback_same_project() returns trigger language plpgsql as $$
begin
  if new.duplicate_of is not null and (select project_id from feedback where id = new.duplicate_of) is distinct from new.project_id then
    raise exception 'duplicate_of must be in the same project' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger feedback_same_project before insert or update of duplicate_of on feedback
  for each row execute function feedback_same_project();

alter table feedback add column source text not null default 'app' check (source in ('app', 'web'));

create index feedback_triage_idx on feedback (project_id, status, priority);
create index feedback_labels_idx on feedback using gin (labels);
create index feedback_duplicate_of_idx on feedback (duplicate_of) where duplicate_of is not null;
-- ponytail: no trigram or lower(text) index; ILIKE over a few thousand rows is fine. Add pg_trgm if a project passes ~50k letters.
