import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { SignInWithApple } from "@capacitor-community/apple-sign-in";
import { supabase, Profile, fetchProfile, Tier } from "../services/supabase";
import { initRevenueCat, logOutRevenueCat, syncIAPEntitlement, isIAPAvailable } from "../services/revenuecat";
import { initPushNotifications, logOutPushNotifications } from "../services/pushNotifications";

// Must exactly match the CFBundleURLSchemes entry in Info.plist / the
// android:scheme intent-filter, and be added to Supabase's Authentication →
// URL Configuration → Redirect URLs allowlist.
const NATIVE_OAUTH_REDIRECT = "io.coinhintz.app://login-callback";

// Sign in with Apple has no Android support (upstream plugin) and we don't
// run the web (Services ID) variant — iOS native only, same gating pattern
// as isIAPAvailable()/isPushAvailable().
const APPLE_SIGNIN_AVAILABLE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

function randomNonce(length = 32): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}


interface AuthContextValue {
  user:        User | null;
  profile:     Profile | null;
  session:     Session | null;
  loading:     boolean;
  profileLoading: boolean;
  tier:        Tier;
  signUp:      (email: string, password: string, fullName: string, username: string) => Promise<string | null>;
  signIn:      (email: string, password: string) => Promise<string | null>;
  signInWithMagicLink: (email: string) => Promise<string | null>;
  signInWithGoogle: () => Promise<string | null>;
  signInWithApple: () => Promise<string | null>;
  appleSignInAvailable: boolean;
  signOut:     () => Promise<void>;
  resetPassword: (email: string) => Promise<string | null>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,           setUser]           = useState<User | null>(null);
  const [profile,        setProfile]        = useState<Profile | null>(null);
  const [session,        setSession]        = useState<Session | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const loadProfile = async (u: User) => {
    setProfileLoading(true);
    const p = await fetchProfile(u.id);
    setProfile(p);
    setProfileLoading(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        loadProfile(data.session.user);
        // Sets RevenueCat's app_user_id = Supabase user id, so a purchase's
        // webhook lands on the right profiles row with no separate mapping
        // table. No-op on web/Android — see isIAPAvailable().
        initRevenueCat(data.session.user.id);
        initPushNotifications(data.session.user.id);
        // Reconciles profiles.tier against RevenueCat directly on every
        // app open, not just right after a purchase — catches a plan
        // change made through Apple's own Settings app (outside ours
        // entirely) and doesn't depend on the webhook having landed.
        if (isIAPAvailable()) syncIAPEntitlement().then(() => loadProfile(data.session!.user));
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        loadProfile(sess.user);
        initRevenueCat(sess.user.id);
        initPushNotifications(sess.user.id);
        if (isIAPAvailable()) syncIAPEntitlement().then(() => loadProfile(sess.user));
      } else {
        setProfile(null);
        logOutRevenueCat();
        logOutPushNotifications();
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Google sign-in on native opens an in-app browser session (see
  // signInWithGoogle below) that Apple/Google eventually redirect to
  // NATIVE_OAUTH_REDIRECT instead of a web page — iOS/Android hand that URL
  // back to the app as appUrlOpen instead of leaving it in the browser.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener("appUrlOpen", async ({ url }) => {
      if (!url.startsWith(NATIVE_OAUTH_REDIRECT)) return;
      await Browser.close().catch(() => {});
      const code = new URL(url).searchParams.get("code");
      if (!code) { console.error("OAuth redirect had no code:", url); return; }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) console.error("OAuth code exchange failed:", error.message);
    });
    return () => { listener.then(l => l.remove()); };
  }, []);

  const signUp = async (email: string, password: string, fullName: string, username: string): Promise<string | null> => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Picked up by fetchProfile's lazy profile-row insert, since
        // there's no server-side trigger creating that row — see
        // services/supabase.ts.
        data: { full_name: fullName, username },
        emailRedirectTo: `${window.location.origin}/`,
      },
    });
    if (!error) {
      supabase.functions.invoke("notify-admin", { body: { event: "signup", email } }).catch(() => {});
    }
    return error?.message ?? null;
  };

  const signIn = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  };

  const signInWithMagicLink = async (email: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    return error?.message ?? null;
  };

  const signInWithGoogle = async (): Promise<string | null> => {
    if (Capacitor.isNativePlatform()) {
      // skipBrowserRedirect: we open the URL ourselves in an in-app browser
      // session instead of letting Supabase navigate the WebView to it —
      // otherwise Google's auth page replaces the app UI with no way back.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: NATIVE_OAUTH_REDIRECT, skipBrowserRedirect: true },
      });
      if (error) return error.message;
      if (data?.url) await Browser.open({ url: data.url });
      return null;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    return error?.message ?? null;
  };

  // Native Sign in with Apple, not the browser-redirect OAuth flow Google
  // uses above — ASAuthorizationAppleIDProvider (inside the plugin) talks
  // to Apple directly via the app's own "Sign in with Apple" capability, no
  // browser hop or appUrlOpen deep link involved. Apple's identity token
  // embeds a hash of the nonce we pass it; Supabase re-hashes the raw nonce
  // we give it here and checks the two match, so both have to travel together.
  const signInWithApple = async (): Promise<string | null> => {
    if (!APPLE_SIGNIN_AVAILABLE) return "Sign in with Apple isn't available here";
    try {
      const rawNonce = randomNonce();
      const hashedNonce = await sha256Hex(rawNonce);
      const { response } = await SignInWithApple.authorize({
        clientId: "io.coinhintz.app",
        redirectURI: "https://coinhintz.io",
        scopes: "email name",
        nonce: hashedNonce,
      });
      const { error } = await supabase.auth.signInWithIdToken({
        provider: "apple",
        token: response.identityToken,
        nonce: rawNonce,
      });
      return error?.message ?? null;
    } catch (err: any) {
      // User dismissed the native Apple ID sheet — not a real error.
      if (String(err?.message ?? err).toLowerCase().includes("cancel")) return null;
      return err?.message ?? "Apple sign-in failed";
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    window.location.replace("/");
  };

  const resetPassword = async (email: string): Promise<string | null> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/?reset=true`,
    });
    return error?.message ?? null;
  };

  const refreshProfile = async () => {
    if (user) await loadProfile(user);
  };

  return (
    <AuthContext.Provider value={{
      user, profile, session, loading, profileLoading,
      tier: profile?.tier ?? "free",
      signUp, signIn, signInWithMagicLink, signInWithGoogle, signInWithApple,
      appleSignInAvailable: APPLE_SIGNIN_AVAILABLE,
      signOut, resetPassword, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
