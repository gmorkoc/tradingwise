import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AccountMenu } from "./AccountMenu";
import "../styles/FlashNewsBanner.css";

interface NewsItem { title: string; url: string; source: string }

const FEEDS = [
  { url: "https://cointelegraph.com/rss",                label: "CoinTelegraph" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",  label: "CoinDesk"      },
  { url: "https://decrypt.co/feed",                      label: "Decrypt"       },
];

async function fetchCryptoNews(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];
  await Promise.allSettled(
    FEEDS.map(async ({ url, label }) => {
      try {
        const res = await fetch(
          `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`
        );
        const data = await res.json();
        if (data.status === "ok") {
          for (const item of data.items) {
            results.push({ title: item.title, url: item.link, source: label });
          }
        }
      } catch { /* silently ignore */ }
    })
  );
  const seen = new Set<string>();
  return results.filter(h => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });
}

interface Props {
  // Desktop web only — see the controls render below. Mobile/iOS keep
  // account/settings/sign-out/theme in the nav drawer untouched.
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
  onOpenProfile?: () => void;
  onOpenSettings?: () => void;
  onSignOut?: () => void;
}

export const FlashNewsBanner: React.FC<Props> = ({
  theme, onToggleTheme, onOpenAuth, onOpenUpgrade, onOpenProfile, onOpenSettings, onSignOut,
}) => {
  const { t } = useTranslation();
  const [items, setItems]       = useState<NewsItem[]>([]);
  const [index, setIndex]       = useState(0);
  const [visible, setVisible]   = useState(true);
  const [loading, setLoading]   = useState(true);
  const intervalRef             = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const news = await fetchCryptoNews();
      if (!cancelled && news.length > 0) { setItems(news); setLoading(false); }
    };
    load();
    const refresh = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(refresh); };
  }, []);

  useEffect(() => {
    if (items.length < 2) return;
    intervalRef.current = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex(i => (i + 1) % items.length);
        setVisible(true);
      }, 400);
    }, 7000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [items]);

  if (loading || items.length === 0) return null;

  const current = items[index];

  return (
    <div className="fnb-root">
      <span className="fnb-tag">
        <span className="fnb-dot" />
        {t("nav.live")}
      </span>
      <span className="fnb-source">{current.source}</span>
      <a
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`fnb-headline${visible ? " fnb-headline--in" : " fnb-headline--out"}`}
      >
        {current.title}
      </a>
      <div className="fnb-controls">
        <button className="fnb-nav" onClick={() => { setVisible(false); setTimeout(() => { setIndex(i => (i - 1 + items.length) % items.length); setVisible(true); }, 300); }}>‹</button>
        <span className="fnb-counter">{index + 1} / {items.length}</span>
        <button className="fnb-nav" onClick={() => { setVisible(false); setTimeout(() => { setIndex(i => (i + 1) % items.length); setVisible(true); }, 300); }}>›</button>
      </div>
      {(onOpenAuth || theme) && (
        <div className="fnb-desktop-controls">
          {onOpenAuth && onOpenUpgrade && (
            <AccountMenu
              onOpenAuth={onOpenAuth}
              onOpenUpgrade={onOpenUpgrade}
              onOpenProfile={onOpenProfile}
              iconFallback
            />
          )}
          {onOpenSettings && (
            <button className="fnb-nav fnb-icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>
          )}
          {onSignOut && (
            <button className="fnb-nav fnb-icon-btn" onClick={onSignOut} title="Sign Out" aria-label="Sign Out">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              <span>Sign Out</span>
            </button>
          )}
          {theme && onToggleTheme && (
            <button
              className={`fnb-theme-toggle icon-strip-theme-pill${theme === "light" ? " light" : ""}`}
              onClick={onToggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              <div className="theme-pill-track">
                <div className="theme-pill-knob">
                  {theme === "dark" ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 5a7 7 0 100 14A7 7 0 0012 5z" /></svg>
                  )}
                </div>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
