// Chart and Advance Chart pages, signed-out visitors only: a floating
// sign-up card that slides in once per visit at a random moment (8–20s
// after the page opens), with a real trading-screen photo at the top.
// ✕ hides it for 24 hours.
//
// Photo: Nick Chong on Unsplash (Unsplash License — free for commercial
// use, no attribution required): unsplash.com/photos/N__BnvQ_w18
import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import "../styles/SignupPromoCard.css";

const SNOOZE_KEY = "ch:advSignupCardClosedAt";
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY = "ch:advSignupCardShown";
const PHOTO = "/promo/signup-trading.jpg";

// One is picked at random each time.
// Only what a free account really gets: $100k paper trading and the
// 3-day ProVision trial (AI reads, Predict and the Agent are Pro).
const VARIANTS = [
  { title: "Practice first. Then trade.", text: "Create a free account and get $100k in paper trading cash, so every real move is one you've already tested." },
  { title: "Your edge starts here.", text: "Sign up free and try ProVision for 3 days: trend-painted candles, buy and sell signals, and where each one is proven wrong." },
  { title: "Catch the next big candle.", text: "A free account gets you $100k of paper money to trade live markets, plus a 3-day ProVision trial to spot the move." },
];

function snoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Date.now() - at < SNOOZE_MS;
  } catch { return false; }
}

export function SignupPromoCard({ onSignUp }: { onSignUp: () => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [variantIdx] = useState(() => Math.floor(Math.random() * VARIANTS.length));
  const variant = VARIANTS[variantIdx];

  // Once per visit, at a random moment 8–20s in — unless snoozed.
  useEffect(() => {
    // Local dev: ?promocard shows it after 1s, ignoring the snooze.
    const forced = import.meta.env.DEV && new URLSearchParams(window.location.search).has("promocard");
    if (!forced && snoozed()) return;
    try { if (!forced && sessionStorage.getItem(SESSION_KEY)) return; } catch { /* ignore */ }
    // Warm the photo so it's there the moment the card slides in.
    const img = new Image();
    img.src = PHOTO;
    const id = window.setTimeout(() => {
      setVisible(true);
      try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* ignore */ }
    }, forced ? 1000 : 8_000 + Math.random() * 12_000);
    return () => window.clearTimeout(id);
  }, []);

  if (!visible) return null;

  const close = () => {
    setVisible(false);
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch { /* ignore */ }
  };

  return ReactDOM.createPortal(
    <div className="spc" role="dialog" aria-label={t("signupPromo.dialogLabel", "Create a free account")}>
      <div className="spc-media">
        <img className="spc-photo" src={PHOTO} alt="" draggable={false} />
        <button type="button" className="spc-close" onClick={close} aria-label={t("signupPromo.close", "Close")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="spc-body">
        <h3 className="spc-title">{t(`signupPromo.v${variantIdx}.title`, variant.title)}</h3>
        <p className="spc-text">{t(`signupPromo.v${variantIdx}.text`, variant.text)}</p>
        <button type="button" className="spc-cta" onClick={() => { setVisible(false); onSignUp(); }}>
          {t("signupPromo.cta", "Join for free")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
