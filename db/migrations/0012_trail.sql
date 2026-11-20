-- Web widget: the tester's last steps on the page before sending (at most 10: a page opened or left, an element
-- clicked, a field changed, never a typed value), cleaned by lib/context.ts. Additive.
-- Ten steps at their longest (name 120, text 80 and url 500 characters at 3 bytes each) are 21,820 bytes as text, so the size check leaves room.
alter table feedback add column trail jsonb check (trail is null or (jsonb_typeof(trail) = 'array' and jsonb_array_length(trail) <= 10 and octet_length(trail::text) <= 30000));
