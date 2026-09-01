import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { saveUsername, isUsernameAvailable, USERNAME_PATTERN } from "../services/supabase";
import "../styles/AuthModal.css";

interface Props {
  userId: string;
  onSaved: () => Promise<void>;
}

type Status = "idle" | "checking" | "available" | "taken" | "invalid";

// Google/Apple sign-in never passes through AuthModal's signup form (there's
// no field to add a username to — it's a redirect straight to the
// provider), so it's the one path that can land a user with no username at
// all. Same gate pattern as TermsGateModal: block the app until it's set,
// covering both a first-time OAuth signup and any pre-existing account from
// before this field existed.
export default function UsernameGateModal({ userId, onSaved }: Props) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [status,   setStatus]   = useState<Status>("idle");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState("");

  useEffect(() => {
    const trimmed = username.trim();
    if (!trimmed) { setStatus("idle"); return; }
    if (!USERNAME_PATTERN.test(trimmed)) { setStatus("invalid"); return; }
    setStatus("checking");
    const handle = setTimeout(() => {
      isUsernameAvailable(trimmed).then(avail => setStatus(avail ? "available" : "taken"));
    }, 450);
    return () => clearTimeout(handle);
  }, [username]);

  const handleSave = async () => {
    if (busy) return;
    const trimmed = username.trim();
    if (!USERNAME_PATTERN.test(trimmed)) { setStatus("invalid"); return; }
    setBusy(true);
    setError("");

    if (status !== "available") {
      const avail = await isUsernameAvailable(trimmed);
      if (!avail) { setStatus("taken"); setBusy(false); return; }
      setStatus("available");
    }

    try {
      await saveUsername(userId, trimmed);
      await onSaved();
    } catch (err: any) {
      setError(err?.message ?? t("upgradeModal.error"));
    }
    setBusy(false);
  };

  return (
    <div className="auth-backdrop">
      <div className="auth-card">
        <h2 className="auth-title">{t("auth.usernameGate.title")}</h2>
        <p className="auth-sub">{t("auth.usernameGate.sub")}</p>

        <label className="auth-label">{t("auth.signup.usernameLabel")}
          <div className="auth-input-wrap">
            <input
              className="auth-input"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              maxLength={20}
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
              autoFocus
            />
          </div>
          {username.trim() && (
            <span className={`auth-username-status auth-username-status--${status}`}>
              {status === "checking" && t("auth.signup.usernameChecking")}
              {status === "available" && t("auth.signup.usernameAvailable")}
              {status === "taken" && t("auth.signup.usernameTaken")}
              {status === "invalid" && t("auth.signup.usernameInvalid")}
            </span>
          )}
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-submit"
          disabled={busy || status !== "available"}
          onClick={handleSave}
          style={{ marginTop: "12px" }}
        >
          {busy ? t("auth.termsGate.saving") : t("auth.usernameGate.continue")}
        </button>
      </div>
    </div>
  );
}
