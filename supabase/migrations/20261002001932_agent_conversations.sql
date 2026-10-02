-- Groups agent_messages into separate conversations (ChatGPT-style: a
-- history list, start a new chat, delete/"clean" an old one) instead of
-- one endless thread. Existing rows (if any from early testing) each get
-- their own id so nothing is lost, just split into one-message threads.
alter table public.agent_messages add column if not exists conversation_id uuid;
update public.agent_messages set conversation_id = gen_random_uuid() where conversation_id is null;
alter table public.agent_messages alter column conversation_id set not null;
alter table public.agent_messages alter column conversation_id set default gen_random_uuid();

create index if not exists agent_messages_conversation_idx
  on public.agent_messages (user_id, conversation_id, created_at);
