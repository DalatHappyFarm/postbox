-- Web widget: the parts of the page the tester marked, numbered like the frames on the screenshot (at most 9, each
-- an element or an area), cleaned by lib/context.ts. Replaces the single `element` (0007), which the API still reads
-- for letters without marks: the old code may write it between this migration and the deploy. Additive.
-- Nine marks at their longest are 33,525 bytes as text, so the size check leaves room.
alter table feedback add column marks jsonb check (marks is null or (jsonb_typeof(marks) = 'array' and jsonb_array_length(marks) <= 9 and octet_length(marks::text) <= 40000));
