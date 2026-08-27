import { ALERT_SOUNDS, type AlertSound } from "../services/supabase";

// Bundled at public/sounds/*.wav (served from the web build) — the exact
// same files are bundled into the iOS app so a push notification's
// apns.payload.aps.sound can reference the same name and sound identical.
export function playAlertSoundFile(sound: string | null | undefined): void {
  const safe: AlertSound = ALERT_SOUNDS.includes(sound as AlertSound) ? (sound as AlertSound) : "bell";
  try {
    new Audio(`/sounds/${safe}.wav`).play().catch(() => { /* blocked without a user gesture */ });
  } catch { /* ignore */ }
}
