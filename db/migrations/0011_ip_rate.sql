-- Submits per IP per hour (RATE_PER_IP_HOUR): the device id is the client's own header, so a script rotating it could
-- otherwise spend a mailbox's whole hourly allowance from one address. A hash like reporter_hash, kept one day like it.
alter table submit_log add column ip_hash text;
create index submit_log_ip_idx on submit_log (ip_hash, created_at);
