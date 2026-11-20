-- The 0007 size check on `logs` (20,000 bytes) was smaller than what lib/context.ts cleanLogs lets through, so a letter
-- with 20 long errors was refused with a 500 and lost. 20 entries at their longest are 68,540 bytes as text.
alter table feedback drop constraint if exists feedback_logs_check;
alter table feedback add constraint feedback_logs_check check (logs is null or (jsonb_typeof(logs) = 'array' and jsonb_array_length(logs) <= 20 and octet_length(logs::text) <= 80000));
