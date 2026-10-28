import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { CoinHintzLogo } from "./CoinHintzLogo";
import { useAuth } from "../contexts/AuthContext";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/Drawer.css";

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  onOpenLeverage: () => void;
  onOpenLearn: () => void;
  onOpenProfile: () => void;
  onOpenWizard: () => void;
  onOpenTutorials: () => void;
  onOpenContact: () => void;
  onOpenAssetCalc: () => void;
  traderLevel: string | null;
}

const LANGUAGES = [
  { code: "en", label: "🇬🇧 English" },
  { code: "es", label: "🇪🇸 Español" },
  { code: "tr", label: "🇹🇷 Türkçe" },
  { code: "it", label: "🇮🇹 Italiano" },
];

const DOC_KEYS = [
  "candlesticks","bollingerBands","rsi","macd","supportResistance",
  "openInterest","fundingRate","longShort","liquidations","leverage","buySell","riskReward",
] as const;

// Line icons (24px grid, stroke) — same style as the side nav's NavIcon.
const ICONS: Record<string, string[]> = {
  profile: ["M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2", "M12 11a4 4 0 100-8 4 4 0 000 8z"],
  level: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M12 18a6 6 0 100-12 6 6 0 000 12z", "M12 14a2 2 0 100-4 2 2 0 000 4z"],
  theme: ["M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"],
  refresh: ["M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"],
  language: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M2 12h20", "M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"],
  ai: ["M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9z"],
  calc: ["M6 2h12a2 2 0 012 2v16a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z", "M8 6h8", "M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h4"],
  leverage: ["M13 2L3 14h9l-1 8 10-12h-9l1-8z"],
  patterns: ["M4 19.5A2.5 2.5 0 016.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"],
  tutorials: ["M22 10L12 5 2 10l10 5 10-5z", "M6 12v5c3 3 9 3 12 0v-5"],
  guide: ["M9 18h6", "M10 22h4", "M12 2a7 7 0 00-4 12.74V17h8v-2.26A7 7 0 0012 2z"],
  contact: ["M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z", "M22 6l-10 7L2 6"],
  signout: ["M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4", "M16 17l5-5-5-5", "M21 12H9"],
};
function Ico({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="drawer-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
function Chevron({ open }: { open?: boolean }) {
  return (
    <svg className={`drawer-chev${open ? " drawer-chev--open" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen, onClose, theme, setTheme, autoRefresh, setAutoRefresh,
  onOpenLeverage, onOpenLearn, onOpenProfile, onOpenWizard, onOpenTutorials, onOpenContact, onOpenAssetCalc, traderLevel,
}) => {
  const { t } = useTranslation();
  const { tier, user, signOut } = useAuth();
  const { used, limit } = useAIQuota();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [openDoc, setOpenDoc]     = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    try { localStorage.setItem("lang", code); } catch { /* noop */ }
  };

  return (
    <>
      {isOpen && <div className="drawer-backdrop" onClick={onClose} />}

      <aside className={`drawer ${isOpen ? "drawer--open" : ""}`}>

        {/* Header */}
        <div className="drawer-header">
          <CoinHintzLogo variant="nav" />
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">

          {/* ── Preferences ───────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">Preferences</h4>

            {/* Profile and Trading Level belong to an account — signed-out
                users don't see them. */}
            {user && (
            <div className="drawer-row drawer-row--clickable" onClick={onOpenProfile}>
              <span className="drawer-row-lead"><Ico name="profile" /><span className="drawer-row-label">{t("drawer.profile")}</span></span>
              <div className="drawer-row-right">
                <span className={`drawer-tier-badge drawer-tier-badge--${tier}`}>
                  {tier.toUpperCase()}
                </span>
                <Chevron />
              </div>
            </div>
            )}

            {user && (
              <div className="drawer-ai-usage">
                <div className="drawer-ai-usage-top">
                  <span className="drawer-row-lead"><Ico name="ai" /><span className="drawer-row-label">AI Requests</span></span>
                  <span className="drawer-ai-usage-count">
                    {tier === "free"
                      ? <span className="drawer-ai-usage-locked">Upgrade to Pro</span>
                      : <>{used}<span className="drawer-ai-usage-limit"> / {tier === "elite" ? "∞" : limit}</span></>
                    }
                  </span>
                </div>
                {tier === "pro" && (
                  <div className="drawer-ai-usage-bar">
                    <div
                      className="drawer-ai-usage-fill"
                      style={{ width: `${Math.min((used / limit) * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {user && (
            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenWizard(); }}>
              <span className="drawer-row-lead"><Ico name="level" /><span className="drawer-row-label">Trading Level</span></span>
              <span className="drawer-badge">{traderLevel ?? "Not set"}</span>
            </div>
            )}

            <div className="drawer-row">
              <span className="drawer-row-lead"><Ico name="theme" /><span className="drawer-row-label">{t("drawer.theme")}</span></span>
              <button className="drawer-toggle-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? "☀ Light" : "☽ Dark"}
              </button>
            </div>

            <div className="drawer-row">
              <span className="drawer-row-lead"><Ico name="refresh" /><span className="drawer-row-label">{t("drawer.autoRefresh")}</span></span>
              <label className="drawer-switch">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                <span className="drawer-switch-track" />
              </label>
            </div>

            <div className="drawer-row">
              <span className="drawer-row-lead"><Ico name="language" /><span className="drawer-row-label">{t("drawer.language")}</span></span>
              <select className="drawer-coin-select" value={i18n.language} onChange={(e) => handleLanguageChange(e.target.value)}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
          </section>

          {/* ── Tools ─────────────────────────────────────── */}
          <section className="drawer-section">
            <button className="drawer-guide-toggle" onClick={() => setToolsOpen(!toolsOpen)} aria-expanded={toolsOpen}>
              <span>Tools</span>
              <Chevron open={toolsOpen} />
            </button>

            {toolsOpen && (
              <div className="drawer-docs">
                <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenAssetCalc(); }}>
                  <span className="drawer-row-lead"><Ico name="calc" /><span className="drawer-row-label">Asset Calculator</span></span>
                  <Chevron />
                </div>

                <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenLeverage(); }}>
                  <span className="drawer-row-lead"><Ico name="leverage" /><span className="drawer-row-label">{t("drawer.leverageBtn")}</span></span>
                  <Chevron />
                </div>

                <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenLearn(); }}>
                  <span className="drawer-row-lead"><Ico name="patterns" /><span className="drawer-row-label">{t("drawer.patternsBtn")}</span></span>
                  <Chevron />
                </div>

                <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenTutorials(); }}>
                  <span className="drawer-row-lead"><Ico name="tutorials" /><span className="drawer-row-label">Trading Tutorials</span></span>
                  <Chevron />
                </div>
              </div>
            )}
          </section>

          {/* ── Trading Guide (collapsible) ────────────────── */}
          <section className="drawer-section">
            <button className="drawer-guide-toggle" onClick={() => setGuideOpen(!guideOpen)} aria-expanded={guideOpen}>
              <span>Trading Guide</span>
              <Chevron open={guideOpen} />
            </button>

            {guideOpen && (
              <div className="drawer-docs">
                {DOC_KEYS.map((key, i) => (
                  <div key={key} className="doc-item">
                    <button
                      className={`doc-trigger${openDoc === i ? " open" : ""}`}
                      onClick={() => setOpenDoc(openDoc === i ? null : i)}
                    >
                      <span>{t(`drawer.docs.${key}.title`)}</span>
                      <span className="doc-chevron">{openDoc === i ? "▲" : "▼"}</span>
                    </button>
                    {openDoc === i && <p className="doc-body">{t(`drawer.docs.${key}.body`)}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Support ───────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">Support</h4>
            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenContact(); }}>
              <span className="drawer-row-lead"><Ico name="contact" /><span className="drawer-row-label">Contact / Feedback</span></span>
              <Chevron />
            </div>
          </section>

          {/* ── Account ───────────────────────────────────── */}
          {user && (
            <section className="drawer-section">
              <div
                className="drawer-row drawer-row--clickable drawer-row--danger"
                onClick={() => { onClose(); signOut(); }}
              >
                <span className="drawer-row-lead"><Ico name="signout" /><span className="drawer-row-label">{t("nav.signOut")}</span></span>
              </div>
            </section>
          )}

          {/* ── Footer ────────────────────────────────────── */}
          <div className="drawer-footer-block">
            <p className="drawer-version">v0.1.0 · coinhintz</p>
            <p className="drawer-footer">{t("drawer.disclaimer")}</p>
          </div>

        </div>
      </aside>
    </>
  );
};
