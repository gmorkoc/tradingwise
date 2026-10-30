-- Agent Ready: at most 10 chats (conversations) per user. A chat is a group
-- of agent_messages sharing conversation_id, so the cap is enforced when the
-- FIRST message of a new conversation is inserted. Messages added to an
-- existing chat (by the user, the app or the server) are never blocked.
-- The app checks first and asks the user to delete a chat; this is the
-- server-side guarantee.

create or replace function public.agent_messages_chat_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n_chats int;
begin
  if exists (
    select 1 from public.agent_messages
     where user_id = new.user_id and conversation_id = new.conversation_id
  ) then
    return new;
  end if;

  select count(distinct conversation_id) into n_chats
    from public.agent_messages
   where user_id = new.user_id;

  if n_chats >= 10 then
    raise exception 'You can have up to 10 chats. Delete one to start a new chat.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists agent_messages_chat_limit on public.agent_messages;
create trigger agent_messages_chat_limit
  before insert on public.agent_messages
  for each row execute function public.agent_messages_chat_limit();

-- Speeds up the per-insert check.
create index if not exists agent_messages_user_conversation_idx
  on public.agent_messages (user_id, conversation_id);
