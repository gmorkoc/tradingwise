import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import "../styles/AuthModal.css";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  shake?: boolean;
}

// Shared by AuthModal.tsx (signup/magic-link) and TermsGateModal.tsx
// (existing users who signed up before this was required) — same legal
// text, same localization, one place to keep them in sync.
export const RiskDisclaimer = forwardRef<HTMLLabelElement, Props>(
  ({ checked, onChange, shake }, ref) => {
    const { t } = useTranslation();
    return (
      <div className="auth-disclaimer">
        <div className="auth-disclaimer-scroll">
          <p className="auth-disclaimer-heading">⚠️ {t("auth.disclaimer.heading")}</p>

          <p className="auth-disclaimer-section">{t("auth.disclaimer.riskSectionTitle")}</p>
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk1") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk2") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk3") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk4") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk5") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.risk6") }} />

          <p className="auth-disclaimer-section">{t("auth.disclaimer.billingSectionTitle")}</p>
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing1") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing2") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing3") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing4") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing5") }} />
          <p dangerouslySetInnerHTML={{ __html: t("auth.disclaimer.billing6") }} />
        </div>
        <label ref={ref} className={`auth-terms-check${shake ? " auth-terms-check--shake" : ""}`}>
          <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
          <span>{t("auth.disclaimer.checkLabel")}</span>
        </label>
      </div>
    );
  }
);
