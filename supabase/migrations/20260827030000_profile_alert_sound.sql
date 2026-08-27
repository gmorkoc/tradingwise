-- User's chosen alert sound — used both client-side (PriceAlerts.tsx toast)
-- and server-side (btc-price-alert-push sets apns.payload.aps.sound to
-- `${alert_sound}.wav`, a file bundled into the iOS app under that exact name).
alter table public.profiles
  add column if not exists alert_sound text not null default 'bell';
