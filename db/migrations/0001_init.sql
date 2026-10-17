create table projects (
  id bigserial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text not null check (char_length(name) between 1 and 100),
  public_key text not null unique check (char_length(public_key) >= 20),
  created_at timestamptz not null default now()
);

create table feedback (
  id bigserial primary key,
  project_id bigint not null references projects (id),
  kind text not null check (kind in ('bug', 'idea', 'other')),
  text text not null check (char_length(text) between 1 and 4000),
  status text not null default 'new' check (status in ('new', 'doing', 'done', 'wont_fix')),
  note text check (char_length(note) <= 4000),
  screen text check (char_length(screen) <= 200),
  app_version text check (char_length(app_version) <= 200),
  build text check (char_length(build) <= 200),
  platform text check (platform in ('ios', 'android', 'web')),
  device text check (char_length(device) <= 200),
  os text check (char_length(os) <= 200),
  locale text check (char_length(locale) <= 200),
  url text check (char_length(url) <= 2000),
  screenshot_key text check (char_length(screenshot_key) <= 300),
  reporter_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index feedback_project_idx on feedback (project_id, id desc);
create index feedback_status_idx on feedback (status, id desc);

-- One row per accepted submit; counted per hour for rate limiting.
create table submit_log (
  id bigserial primary key,
  project_id bigint not null references projects (id),
  reporter_hash text not null,
  created_at timestamptz not null default now()
);
create index submit_log_reporter_idx on submit_log (reporter_hash, created_at);
create index submit_log_project_idx on submit_log (project_id, created_at);
