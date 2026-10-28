import { Capacitor, registerPlugin } from "@capacitor/core";
import { supabase } from "./supabase";

// Passkeys (Face ID / Touch ID / device PIN) on top of Supabase Auth.
//
// Web: Supabase runs the whole browser WebAuthn ceremony itself.
// iOS app: the web view (capacitor://localhost) can't use passkeys for
// www.coinhintz.io, so the native PasskeyPlugin.swift shows Apple's passkey
// sheet and we pass its result to Supabase's two-step verify calls.
//
// Server side must be switched on in the Supabase dashboard (Auth →
// Passkeys, relying party www.coinhintz.io) — until then every call here
// returns that Supabase error, which the UI shows as-is.

interface PasskeyNative {
  isSupported(): Promise<{ supported: boolean }>;
  create(opts: { options: unknown }): Promise<{ credential: unknown }>;
  get(opts: { options: unknown }): Promise<{ credential: unknown }>;
}
const PasskeyNative = registerPlugin<PasskeyNative>("Passkey");

const isNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

// A user closing the Face ID sheet isn't an error worth showing.
const CANCELLED = "__passkey_cancelled__";
function isCancel(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string } | null;
  return e?.code === "CANCELLED" || e?.message === "cancelled" || e?.name === "NotAllowedError" || e?.name === "AbortError";
}

export async function passkeysAvailable(): Promise<boolean> {
  try {
    if (isNative()) return (await PasskeyNative.isSupported()).supported;
    return typeof window !== "undefined" && "PublicKeyCredential" in window && window.isSecureContext;
  } catch {
    return false;
  }
}

/** Sign in with a passkey. Returns an error message, or null on success / when the user cancelled. */
export async function signInWithPasskey(): Promise<string | null> {
  try {
    if (!isNative()) {
      const { error } = await supabase.auth.signInWithPasskey();
      if (error) return isCancel(error) ? null : error.message;
      return null;
    }
    const start = await supabase.auth.passkey.startAuthentication();
    if (start.error || !start.data) return start.error?.message ?? "Couldn't start passkey sign-in";
    const { credential } = await PasskeyNative.get({ options: start.data.options });
    const verify = await supabase.auth.passkey.verifyAuthentication({
      challengeId: start.data.challenge_id,
      credential: credential as Parameters<typeof supabase.auth.passkey.verifyAuthentication>[0]["credential"],
    });
    if (verify.error) return verify.error.message;
    return null;
  } catch (err) {
    if (isCancel(err)) return null;
    return (err as Error)?.message ?? "Passkey sign-in failed";
  }
}

/** Add a passkey to the signed-in account. Returns an error message, CANCELLED, or null on success. */
export async function addPasskey(): Promise<string | null> {
  try {
    if (!isNative()) {
      const { error } = await supabase.auth.registerPasskey();
      if (error) return isCancel(error) ? CANCELLED : error.message;
      return null;
    }
    const start = await supabase.auth.passkey.startRegistration();
    if (start.error || !start.data) return start.error?.message ?? "Couldn't start passkey setup";
    const { credential } = await PasskeyNative.create({ options: start.data.options });
    const verify = await supabase.auth.passkey.verifyRegistration({
      challengeId: start.data.challenge_id,
      credential: credential as Parameters<typeof supabase.auth.passkey.verifyRegistration>[0]["credential"],
    });
    if (verify.error) return verify.error.message;
    return null;
  } catch (err) {
    if (isCancel(err)) return CANCELLED;
    return (err as Error)?.message ?? "Passkey setup failed";
  }
}
export const PASSKEY_CANCELLED = CANCELLED;

export interface PasskeyItem { id: string; friendly_name?: string; created_at: string }

export async function listPasskeys(): Promise<PasskeyItem[]> {
  const { data, error } = await supabase.auth.passkey.list();
  if (error || !data) return [];
  return data as PasskeyItem[];
}

export async function removePasskey(passkeyId: string): Promise<string | null> {
  const { error } = await supabase.auth.passkey.delete({ passkeyId });
  return error ? error.message : null;
}
