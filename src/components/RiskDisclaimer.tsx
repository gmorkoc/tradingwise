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
    const { t, i18n } = useTranslation();
    // Same localized legal pages the upgrade screen links to.
    const legalSuffix = ["es", "it", "tr"].includes(i18n.language) ? `.${i18n.language}` : "";
    // "Terms of Use" and "Billing Policy" inside the checkbox sentence link
    // to the Terms page (which includes the Billing & Subscription Policy).
    // Tapping a link opens it without ticking the box.
    const termsUrl = `https://coinhintz.io/terms${legalSuffix}.html`;
    const LINK_WORDS = [
      "Terms of Use", "Billing Policy",
      "Términos de Uso", "Política de Facturación",
      "Termini di Utilizzo", "Politica di Fatturazione",
      "Kullanım Şartları", "Faturalama Politikası",
    ];
    const label = t("auth.disclaimer.checkLabel");
    const re = new RegExp(`(${LINK_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
    const linkedLabel = label.split(re).map((part, i) =>
      LINK_WORDS.includes(part) ? (
        <a key={i} href={termsUrl} target="_blank" rel="noopener noreferrer" className="auth-terms-link" onClick={(e) => e.stopPropagation()}>
          {part}
        </a>
      ) : (
        part
      ),
    );
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
          <span>{linkedLabel}</span>
        </label>
      </div>
    );
  }
);
