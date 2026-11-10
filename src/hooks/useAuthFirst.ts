import { useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";

/** Fired by App when the sign-in window closes without anyone signing in. */
export const AUTH_DISMISSED_EVENT = "auth-dismissed";

/**
 * Upgrade screens are for signed-in users. While `active` and nobody is
 * signed in, this opens the sign-in window (same "Welcome to coinhintz"
 * screen the Agent Ready button opens) once, and returns false so the
 * caller hides its upgrade content. After sign-in it returns true and the
 * upgrade screen shows. Closing the sign-in window without signing in calls
 * `onCancel` (e.g. close the paywall) when given.
 */
export function useAuthFirst(active: boolean, onOpenAuth: () => void, onCancel?: () => void): boolean {
  const { user, loading } = useAuth();
  const asked = useRef(false);
  const openRef = useRef(onOpenAuth);
  openRef.current = onOpenAuth;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!active) { asked.current = false; return; }
    if (loading || user || asked.current) return;
    asked.current = true;
    openRef.current();
  }, [active, user, loading]);

  useEffect(() => {
    if (!active || user) return;
    const h = () => cancelRef.current?.();
    window.addEventListener(AUTH_DISMISSED_EVENT, h);
    return () => window.removeEventListener(AUTH_DISMISSED_EVENT, h);
  }, [active, user]);

  return !!user;
}
