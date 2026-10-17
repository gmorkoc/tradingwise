-- "Ask Agent Ready" button (Advance Chart page) — a user turn can now
-- carry the chart screenshot that was actually sent for analysis, so it
-- stays visible in the message bubble after the optimistic local-only
-- render is replaced by the real reload (loadAll in TradingAgent.tsx),
-- instead of only existing for the one OpenAI vision call and then
-- disappearing. Same additive-column pattern as thought_process/
-- navigate_to/positions_list before it.
alter table public.agent_messages
  add column if not exists image_url text;
