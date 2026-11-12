-- Web widget slice 2: the page's recent errors and failed requests (`logs`, at most 20) and the element the tester
-- pointed at (`element`), both cleaned by lib/context.ts before they are stored. Additive.
alter table feedback add column logs jsonb check (logs is null or (jsonb_typeof(logs) = 'array' and jsonb_array_length(logs) <= 20 and octet_length(logs::text) <= 20000));
alter table feedback add column element jsonb check (element is null or (jsonb_typeof(element) = 'object' and octet_length(element::text) <= 2000));
