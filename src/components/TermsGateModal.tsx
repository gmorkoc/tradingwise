import { useState } from "react";
import { useTranslation } from "react-i18next";
import { saveTermsAgreement } from "../services/supabase";
import { RiskDisclaimer } from "./RiskDisclaimer";
import "../styles/AuthModal.css";

interface Props {
  userId: string;
  onAgreed: () => Promise<void>;
}

export default function TermsGateModal({ userId, onAgreed }: Props) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState("");

  const handleAgree = async () => {
    if (!agreed || busy) return;
    setBusy(true);
    setError("");
    const now = new Date().toISOString();
    const { error: saveError } = await saveTermsAgreement(userId, now);
    if (saveError) {
      console.error("TermsGateModal: failed to save agreement:", saveError);
      setError(t("auth.termsGate.saveError"));
      setBusy(false);
      return;
    }
    try {
      await onAgreed();
    } catch (err) {
      console.error("TermsGateModal: onAgreed (refreshProfile) threw:", err);
    }
    setBusy(false);
  };

  return (
    <div className="auth-backdrop">
      <div className="auth-card">
        <RiskDisclaimer checked={agreed} onChange={setAgreed} />

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-submit"
          disabled={!agreed || busy}
          onClick={handleAgree}
          style={{ marginTop: "12px" }}
        >
          {busy ? t("auth.termsGate.saving") : t("auth.termsGate.agreeAndContinue")}
        </button>
      </div>
    </div>
  );
}
