import { useState } from "react";
import { saveTermsAgreement } from "../services/supabase";

interface Props {
  userId: string;
  onAgreed: () => Promise<void>;
}

export default function TermsGateModal({ userId, onAgreed }: Props) {
  const [agreed, setAgreed] = useState(false);
  const [busy,   setBusy]   = useState(false);

  const handleAgree = async () => {
    if (!agreed || busy) return;
    setBusy(true);
    const now = new Date().toISOString();
    await saveTermsAgreement(userId, now);
    await onAgreed();
    setBusy(false);
  };

  return (
    <div className="auth-backdrop">
      <div className="auth-card">
        <div className="auth-disclaimer">
          <div className="auth-disclaimer-scroll">
            <p className="auth-disclaimer-heading">⚠️ Risk Disclaimer &amp; Terms of Use</p>

            <p className="auth-disclaimer-section">Market &amp; Platform Risk</p>
            <p>coinhintz provides market data, analytical tools, and AI-generated signals for <strong>informational and educational purposes only</strong>. Nothing on this platform constitutes financial, investment, legal, or tax advice of any kind.</p>
            <p><strong>Cryptocurrency trading involves substantial risk of loss.</strong> Digital asset markets are highly volatile and largely unregulated. You may lose some or all of your invested capital. Never invest money you cannot afford to lose.</p>
            <p>All AI predictions, signals, funding rate analyses, and market insights are generated algorithmically and are <strong>not guaranteed to be accurate, complete, or timely</strong>. Past performance does not guarantee future results.</p>
            <p>Market data may be delayed, incomplete, or inaccurate. coinhintz makes no representations regarding data accuracy and is not liable for errors or omissions.</p>
            <p><strong>You are solely responsible for any financial decisions you make.</strong> coinhintz bears no liability for any losses or damages arising from your use of this platform.</p>
            <p>This platform is for users of legal age who are legally permitted to engage with cryptocurrency services in their jurisdiction.</p>

            <p className="auth-disclaimer-section">Billing &amp; Subscription Policy</p>
            <p><strong>Subscriptions auto-renew</strong> monthly at the listed price until cancelled. By subscribing you authorise coinhintz to charge your payment method on a recurring basis.</p>
            <p><strong>No refunds.</strong> All payments are final and non-refundable. We do not issue partial or full refunds for any reason, including unused time, dissatisfaction, or accidental purchases.</p>
            <p><strong>Cancellation.</strong> You may cancel your subscription at any time. Cancellation takes effect at the end of your current billing period — you retain full access to your plan features until that date, after which your account reverts to the Free tier. No credit or refund is issued for the remaining unused days.</p>
            <p><strong>Plan upgrades</strong> take effect immediately. Only the prorated difference for the remaining billing period is charged; your renewal date does not change.</p>
            <p><strong>Plan downgrades</strong> are scheduled to take effect at the end of your current billing period. You keep your higher-tier access until then. No refund or credit is issued for the difference.</p>
            <p>coinhintz reserves the right to change pricing with reasonable notice. Continued use of the service after a price change constitutes acceptance of the new price.</p>
          </div>

          <label className="auth-terms-check">
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
            <span>I have read and agree to the Risk Disclaimer, Terms of Use, and Billing Policy above</span>
          </label>
        </div>

        <button
          className="auth-submit"
          disabled={!agreed || busy}
          onClick={handleAgree}
          style={{ marginTop: "12px" }}
        >
          {busy ? "Saving…" : "I Agree & Continue →"}
        </button>
      </div>
    </div>
  );
}
