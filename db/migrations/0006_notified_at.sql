-- When the owner was last told about new letters in this mailbox (lib/notify.ts); null means never. Additive.
alter table projects add column notified_at timestamptz;
