-- Threaded replies. Kept one level deep on purpose (see openReply in
-- CoinChat.tsx, which always attaches to the root ancestor) — a reply-to-
-- a-reply still sets reply_to_id to the original top-level comment, so
-- rendering never has to handle arbitrary nesting depth.
alter table public.coin_comments
  add column if not exists reply_to_id bigint references public.coin_comments(id) on delete set null;

create index if not exists coin_comments_reply_to_idx
  on public.coin_comments (reply_to_id)
  where reply_to_id is not null;
