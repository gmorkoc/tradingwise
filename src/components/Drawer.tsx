import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
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
  traderLevel: string | null;
}

const LANGUAGES = [
  { code: "en", label: "🇬🇧 English" },
  { code: "es", label: "🇪🇸 Español" },
  { code: "tr", label: "🇹🇷 Türkçe" },
  { code: "it", label: "🇮🇹 Italiano" },
];

const DOC_KEYS = [
  "candlesticks",
  "bollingerBands",
  "rsi",
  "macd",
  "supportResistance",
  "openInterest",
  "fundingRate",
  "longShort",
  "liquidations",
  "leverage",
  "buySell",
  "riskReward",
] as const;

export const Drawer: React.FC<DrawerProps> = ({
  isOpen, onClose, theme, setTheme, autoRefresh, setAutoRefresh, onOpenLeverage, onOpenLearn, onOpenProfile, onOpenWizard, traderLevel,
}) => {
  const { t } = useTranslation();
  const [openDoc, setOpenDoc] = useState<number | null>(null);

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
        <div className="drawer-header">
          <span className="drawer-logo">{t("drawer.logo")}</span>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-body">

          {/* ── Settings ────────────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">{t("drawer.settings")}</h4>

            {/* Profile */}
            <div className="drawer-setting drawer-setting--clickable" onClick={onOpenProfile}>
              <span>{t("drawer.profile")}</span>
              <span className="drawer-setting-arrow">›</span>
            </div>

            {/* Trader level wizard */}
            <div className="drawer-setting drawer-setting--clickable" onClick={() => { onClose(); onOpenWizard(); }}>
              <span>Trading Level</span>
              <span className="drawer-wizard-badge">
                {traderLevel ?? "not set"}
              </span>
            </div>

            <div className="drawer-setting">
              <span>{t("drawer.theme")}</span>
              <button
                className="drawer-toggle-btn"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? t("drawer.lightMode") : t("drawer.darkMode")}
              </button>
            </div>

            <div className="drawer-setting">
              <span>{t("drawer.autoRefresh")}</span>
              <label className="drawer-switch">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                <span className="drawer-switch-track" />
              </label>
            </div>

            <div className="drawer-setting">
              <span>{t("drawer.language")}</span>
              <select
                className="drawer-coin-select"
                value={i18n.language}
                onChange={(e) => handleLanguageChange(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </section>

          {/* ── Tools ───────────────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">{t("drawer.tools")}</h4>
            <button
              className="drawer-leverage-btn"
              onClick={() => { onClose(); onOpenLeverage(); }}
            >
              {t("drawer.leverageBtn")}
            </button>
            <button
              className="drawer-leverage-btn"
              style={{ marginTop: 8 }}
              onClick={() => { onClose(); onOpenLearn(); }}
            >
              {t("drawer.patternsBtn")}
            </button>
          </section>

          {/* ── App Info ─────────────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">{t("drawer.appInfo")}</h4>
            <div className="drawer-info-grid">
              <span className="info-label">{t("common.version")}</span>
              <span className="info-value">0.1.0</span>
              <span className="info-label">{t("drawer.priceData")}</span>
              <span className="info-value">Binance · CoinGlass</span>
              <span className="info-label">{t("drawer.charts")}</span>
              <span className="info-value">TradingView Lightweight</span>
              <span className="info-label">{t("drawer.ai")}</span>
              <span className="info-value">OpenAI GPT</span>
            </div>
            <div className="drawer-links">
              <a
                href="https://github.com/anthropics/claude-code/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="drawer-link"
              >
                {t("drawer.reportIssue")}
              </a>
              <a
                href="https://www.binance.com/en/binance-api"
                target="_blank"
                rel="noopener noreferrer"
                className="drawer-link"
              >
                {t("drawer.dataSource")}
              </a>
            </div>
          </section>

          {/* ── Trading Docs ──────────────────────────────────────── */}
          <section className="drawer-section">
            <h4 className="drawer-section-title">{t("drawer.tradingGuide")}</h4>
            <div className="drawer-docs">
              {DOC_KEYS.map((key, i) => (
                <div key={key} className="doc-item">
                  <button
                    className={`doc-trigger ${openDoc === i ? "open" : ""}`}
                    onClick={() => setOpenDoc(openDoc === i ? null : i)}
                  >
                    <span>{t(`drawer.docs.${key}.title`)}</span>
                    <span className="doc-chevron">{openDoc === i ? "▲" : "▼"}</span>
                  </button>
                  {openDoc === i && (
                    <p className="doc-body">{t(`drawer.docs.${key}.body`)}</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <p className="drawer-footer">
            {t("drawer.disclaimer")}
          </p>
        </div>
      </aside>
    </>
  );
};
