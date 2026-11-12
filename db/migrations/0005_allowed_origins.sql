-- Websites allowed to send letters with a mailbox's public key (lib/origins.ts); empty means any origin. Additive.
alter table projects add column allowed_origins text[] not null default '{}' check (cardinality(allowed_origins) <= 20);
