import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { supabase, Profile, fetchProfile, Tier } from "../services/supabase";
import { initRevenueCat, logOutRevenueCat } from "../services/revenuecat";

// Must exactly match the CFBundleURLSchemes entry in Info.plist / the
// android:scheme intent-filter, and be added to Supabase's Authentication →
// URL Configuration → Redirect URLs allowlist.
const NATIVE_OAUTH_REDIRECT = "io.coinhintz.app://login-callback";


interface AuthContextValue {
  user:        User | null;
  profile:     Profile | null;
  session:     Session | null;
  loading:     boolean;
  profileLoading: boolean;
  tier:        Tier;
  signUp:      (email: string, password: string, fullName: string) => Promise<string | null>;
  signIn:      (email: string, password: string) => Promise<string | null>;
  signInWithMagicLink: (email: string) => Promise<string | null>;
  signInWithGoogle: () => Promise<string | null>;
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
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        loadProfile(sess.user);
        initRevenueCat(sess.user.id);
      } else {
        setProfile(null);
        logOutRevenueCat();
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

  const signUp = async (email: string, password: string, fullName: string): Promise<string | null> => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
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
      signUp, signIn, signInWithMagicLink, signInWithGoogle, signOut, resetPassword, refreshProfile,
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
