-- Real headlines (title/source/url, resolved server-side from actual RSS
-- fetches, never model-invented) the agent factored into a given reply —
-- mirrored onto agent_messages so past turns still show their sources
-- after a reload, same reasoning as the existing action/basket/question
-- columns.
alter table public.agent_messages
  add column if not exists news_sources jsonb;
