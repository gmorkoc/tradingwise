import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { CoinHintzLogo } from "./CoinHintzLogo";
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

export const Drawer: React.FC<DrawerProps> = ({
  isOpen, onClose, theme, setTheme, autoRefresh, setAutoRefresh,
  onOpenLeverage, onOpenLearn, onOpenProfile, onOpenWizard, onOpenTutorials, onOpenContact, traderLevel,
}) => {
  const { t } = useTranslation();
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
          <button className="drawer-close" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-body">

          {/* ── Preferences ───────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">Preferences</h4>

            <div className="drawer-row drawer-row--clickable" onClick={onOpenProfile}>
              <span className="drawer-row-label">{t("drawer.profile")}</span>
              <span className="drawer-row-arrow">›</span>
            </div>

            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenWizard(); }}>
              <span className="drawer-row-label">Trading Level</span>
              <span className="drawer-badge">{traderLevel ?? "Not set"}</span>
            </div>

            <div className="drawer-row">
              <span className="drawer-row-label">{t("drawer.theme")}</span>
              <button className="drawer-toggle-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? "☀ Light" : "☽ Dark"}
              </button>
            </div>

            <div className="drawer-row">
              <span className="drawer-row-label">{t("drawer.autoRefresh")}</span>
              <label className="drawer-switch">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                <span className="drawer-switch-track" />
              </label>
            </div>

            <div className="drawer-row">
              <span className="drawer-row-label">{t("drawer.language")}</span>
              <select className="drawer-coin-select" value={i18n.language} onChange={(e) => handleLanguageChange(e.target.value)}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
          </section>

          {/* ── Tools ─────────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">Tools</h4>

            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenLeverage(); }}>
              <span className="drawer-row-label">{t("drawer.leverageBtn")}</span>
              <span className="drawer-row-right"><span className="drawer-row-icon">⚡</span><span className="drawer-row-arrow">›</span></span>
            </div>

            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenLearn(); }}>
              <span className="drawer-row-label">{t("drawer.patternsBtn")}</span>
              <span className="drawer-row-right"><span className="drawer-row-icon">📚</span><span className="drawer-row-arrow">›</span></span>
            </div>

            <div className="drawer-row drawer-row--clickable" onClick={() => { onClose(); onOpenTutorials(); }}>
              <span className="drawer-row-label">Trading Tutorials</span>
              <span className="drawer-row-right"><span className="drawer-row-icon">🎓</span><span className="drawer-row-arrow">›</span></span>

            </div>
          </section>

          {/* ── Trading Guide (collapsible) ────────────────── */}
          <section className="drawer-section">
            <button className="drawer-guide-toggle" onClick={() => setGuideOpen(!guideOpen)}>
              <span>Trading Guide</span>
              <span className="drawer-guide-chevron">{guideOpen ? "▲" : "▼"}</span>
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
              <span className="drawer-row-label">Contact / Feedback</span>
              <span className="drawer-row-right"><span className="drawer-row-icon">✉️</span><span className="drawer-row-arrow">›</span></span>
            </div>
          </section>

          {/* ── Footer ────────────────────────────────────── */}
          <div className="drawer-footer-block">
            <p className="drawer-version">v0.1.0 · Binance · CoinGlass · OpenAI GPT</p>
            <p className="drawer-footer">{t("drawer.disclaimer")}</p>
          </div>

        </div>
      </aside>
    </>
  );
};
