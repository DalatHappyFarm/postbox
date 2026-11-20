-- Web widget: a mark may carry `style`, the computed style of the element in one line (at most 500 characters, cleaned by
-- lib/context.ts). Nine marks at their longest are 47,142 bytes as text, over the 40,000 of 0009, so the size check on
-- `marks` is replaced by one that leaves room. Only the check changes; no data does.
alter table feedback drop constraint if exists feedback_marks_check;
alter table feedback add constraint feedback_marks_check check (marks is null or (jsonb_typeof(marks) = 'array' and jsonb_array_length(marks) <= 9 and octet_length(marks::text) <= 60000));
