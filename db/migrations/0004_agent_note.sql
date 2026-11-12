-- The agent's own note (progress or what it changed), kept apart from the owner's decision in `note`,
-- so closing a letter no longer overwrites what the owner asked for. Additive.
alter table feedback add column agent_note text check (char_length(agent_note) <= 10000);
