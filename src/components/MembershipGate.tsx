import { useState, ReactNode } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Tier, hasAccess } from "../services/supabase";
import { redirectToCheckout, PRICE_IDS } from "../services/stripeService";
import "../styles/AIQuotaWall.css";
import "../styles/MembershipGate.css";

const TIER_COLOR: Record<Tier, string> = {
  free:  "#94a3b8",
  pro:   "#38bdf8",
  elite: "#a78bfa",
};

interface FeatureItem { icon: string; title: string; desc: string; }

const TIER_COPY: Record<Tier, {
  headline: string;
  sub: string;
  features: FeatureItem[];
  cta: string;
  price: string;
  trust: string;
}> = {
  free: {
    headline: "",
    sub: "",
    features: [],
    cta: "",
    price: "",
    trust: "",
  },
  pro: {
    headline: "Trade Smarter with AI",
    sub: "Get real-time AI-powered analysis across price action, on-chain data, and market sentiment — all in one place.",
    features: [
      { icon: "✦", title: "AI Market Intelligence",    desc: "GPT-4o reads the market for you — patterns, momentum, and bias at a glance." },
      { icon: "⛓",  title: "On-Chain AI Analysis",     desc: "Network health, miner behavior, and chain signals interpreted in plain language." },
      { icon: "📈", title: "AI Price Predictions",     desc: "Multi-scenario forecasts with confidence levels updated every interval." },
      { icon: "💬", title: "AI Trading Assistant",     desc: "Ask anything — strategy, setups, risk — and get institutional-grade answers." },
    ],
    cta: "Unlock Pro — $10.99/mo",
    price: "$10.99/mo",
    trust: "35 AI requests/week · Cancel anytime · Instant access",
  },
  elite: {
    headline: "The Edge Professionals Use",
    sub: "Gann Analysis, Coinbase Premium, and unlimited AI — the full institutional toolkit, no caps.",
    features: [
      { icon: "📐", title: "Gann Analysis AI",          desc: "Square of 9, Gann angles, and cycle forecasts interpreted by GPT-4o — exclusive to Elite." },
      { icon: "⚡", title: "Unlimited AI Requests",     desc: "No weekly cap — use every AI feature as much as you need." },
      { icon: "🏦", title: "Coinbase Premium AI",       desc: "Institutional flow vs retail divergence interpreted in real time." },
    ],
    cta: "Unlock Elite — $29.99/mo",
    price: "$29.99/mo",
    trust: "Unlimited AI · Cancel anytime · Includes everything in Pro",
  },
};

interface Props {
  requiredTier: Tier;
  children: ReactNode;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  featureName?: string;
}

function CheckIcon({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  );
}

export const MembershipGate: React.FC<Props> = ({
  requiredTier, children, onOpenAuth, onOpenUpgrade, featureName,
}) => {
  const { user, tier, loading } = useAuth();

  if (loading) return <div className="mg-loading">Loading…</div>;

  if (!user) {
    return (
      <div className="mg-wall">
        <div className="mg-orb mg-orb--1" />
        <div className="mg-orb mg-orb--2" />
        <div className="mg-inner">
          <div className="mg-icon-wrap mg-icon-wrap--lock">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
          </div>
          <div className="mg-headline-block">
            <h3 className="mg-title">Sign in to continue</h3>
            <p className="mg-sub">Create a free account to access {featureName ?? "this feature"} and unlock your edge in the market.</p>
          </div>
          <div className="mg-free-perks">
            {["Live price & order book", "Fear & Greed gauge", "On-chain metrics", "Liquidation heatmap"].map(p => (
              <div key={p} className="mg-free-perk">
                <CheckIcon color="#22c55e" />
                <span>{p}</span>
              </div>
            ))}
          </div>
          <button className="mg-cta mg-cta--neutral" onClick={onOpenAuth}>
            Sign In / Sign Up — It's Free
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <p className="mg-trust">No credit card required · Free forever plan</p>
        </div>
      </div>
    );
  }

  if (!hasAccess(tier, requiredTier)) {
    const color = TIER_COLOR[requiredTier];
    const copy  = TIER_COPY[requiredTier];

    return (
      <div className="mg-wall">
        <div className="mg-orb mg-orb--1" />
        <div className="mg-orb mg-orb--2" />
        <div className="mg-inner">

          {/* Headline */}
          <div className="mg-headline-block">
            <h3 className="mg-title">{copy.headline}</h3>
            <p className="mg-sub">{copy.sub}</p>
          </div>

          {/* Feature cards */}
          <div className="mg-feature-grid">
            {copy.features.map(f => (
              <div key={f.title} className="mg-feature-card">
                <span className="mg-feature-icon">{f.icon}</span>
                <div>
                  <p className="mg-feature-title">{f.title}</p>
                  <p className="mg-feature-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            className="mg-cta"
            style={{ "--mg-color": color } as React.CSSProperties}
            onClick={onOpenUpgrade}
          >
            {copy.cta}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <p className="mg-trust">{copy.trust}</p>

        </div>
      </div>
    );
  }

  return <>{children}</>;
};

/* ── BlurGate: renders content blurred with a floating upgrade card ───────── */
export const BlurGate: React.FC<Props> = ({ requiredTier, children, onOpenAuth }) => {
  const { user, tier, loading } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState(false);

  if (loading) return <>{children}</>;
  if (user && hasAccess(tier, requiredTier)) return <>{children}</>;

  const handleUpgrade = async () => {
    setLoadingPlan(true);
    await redirectToCheckout(PRICE_IDS.elite);
    setLoadingPlan(false);
  };

  return (
    <div className="bg-root">
      <div className="bg-content" aria-hidden="true">
        {children}
      </div>
      <div className="bg-overlay">
        <div className="aiqw-plan bg-plan-card" style={{ "--plan-color": "#a78bfa" } as React.CSSProperties}>
          <div className="aiqw-plan-header">
            <span className="aiqw-plan-label" style={{ color: "#a78bfa" }}>Elite</span>
            <span className="aiqw-plan-price">$29.99<span className="aiqw-plan-per">/mo</span></span>
          </div>
          <ul className="aiqw-plan-features">
            {["Everything in Pro — unlimited", "Gann Analysis AI", "Coinbase Premium AI"].map(f => (
              <li key={f}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                {f}
              </li>
            ))}
          </ul>
          <button
            className="aiqw-plan-btn"
            style={{ background: "linear-gradient(135deg, #a78bfacc, #a78bfa88)", borderColor: "#a78bfa55" }}
            onClick={!user ? onOpenAuth : handleUpgrade}
            disabled={loadingPlan}
          >
            {!user ? "Sign in to upgrade" : loadingPlan ? "Redirecting…" : "Upgrade to Elite"}
          </button>
          <p className="bg-card-trust">Cancel anytime · Includes everything in Pro</p>
        </div>
      </div>
    </div>
  );
};
