import { useState, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { COINS } from "../services/coinglass";
import {
  fetchCoinComments, postCoinComment, deleteCoinComment, reportCoinComment,
  subscribeToCoinComments, unsubscribeFromCoinComments, COIN_COMMENT_MAX_LENGTH,
  type CoinComment,
} from "../services/coinChat";
import { CoinMarketMood } from "./CoinMarketMood";
import "../styles/CoinChat.css";

interface Props {
  coin: string;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
  // Desktop has no self-managed open/close state — visibility belongs to
  // the parent's side-panel dock (same pattern as Watchlist), so closing
  // from inside the panel just asks the parent to collapse it.
  onCloseDesktop?: () => void;
}

function coinName(symbol: string): string {
  return COINS.find((c) => c.symbol === symbol)?.name ?? symbol;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

export function CoinChat({ coin, onOpenAuth, onOpenUpgrade, onCloseDesktop }: Props) {
  const { t } = useTranslation();
  const { user, tier } = useAuth();
  const isPaid = tier === "pro" || tier === "elite";
  const isDesktop = useIsDesktop();

  const [comments, setComments] = useState<CoinComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false); // mobile swipe-up sheet only
  const [reportedIds, setReportedIds] = useState<Set<number>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // capacitor.config.ts sets Keyboard resize:'none' globally, so this
  // fixed-position mobile sheet never shrinks for the keyboard on its own —
  // the composer at its bottom just ends up hidden underneath it. Pulling
  // the sheet's own `bottom` up by the keyboard height keeps the composer
  // above the keyboard, same fix as ChatInterface.tsx's panel.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (panelRef.current) panelRef.current.style.bottom = `${info.keyboardHeight}px`;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (panelRef.current) panelRef.current.style.bottom = "0px";
    });
    return () => { showSub.then(s => s.remove()); hideSub.then(s => s.remove()); };
  }, []);

  useEffect(() => {
    if (openMenuId === null) return;
    const handle = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".coin-chat-comment-menu-wrap")) setOpenMenuId(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [openMenuId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDraft(""); setError("");

    fetchCoinComments(coin).then((rows) => {
      if (!cancelled) { setComments(rows); setLoading(false); }
    });

    const channel = subscribeToCoinComments(
      coin,
      (comment) => setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [comment, ...prev])),
      (id) => setComments((prev) => prev.filter((c) => c.id !== id))
    );

    return () => { cancelled = true; unsubscribeFromCoinComments(channel); };
  }, [coin]);

  const handlePost = async () => {
    if (!user || !draft.trim() || posting) return;
    setPosting(true); setError("");
    try {
      await postCoinComment(coin, user.id, draft);
      setDraft("");
    } catch (e: any) {
      setError(e.message ?? t("coinChat.postFailed"));
    }
    setPosting(false);
  };

  const handleDelete = async (id: number) => {
    const prev = comments;
    setComments((c) => c.filter((x) => x.id !== id));
    try { await deleteCoinComment(id); }
    catch { setComments(prev); }
  };

  const handleReport = async (id: number) => {
    if (!user) return;
    setReportedIds((prev) => new Set(prev).add(id));
    try { await reportCoinComment(id, user.id); } catch { /* stays marked locally either way */ }
  };

  const feed = (
    <div className="coin-chat-feed">
      {loading ? (
        <p className="coin-chat-empty">{t("common.loading")}</p>
      ) : comments.length === 0 ? (
        <div className="coin-chat-empty-state">
          <div className="coin-chat-empty-icon">💬</div>
          <p className="coin-chat-empty-title">{t("coinChat.emptyTitle", "No comments yet")}</p>
          <p className="coin-chat-empty-sub">{t("coinChat.empty", { coin })}</p>
          {!user ? (
            <button type="button" className="coin-chat-empty-cta" onClick={onOpenAuth}>
              {t("coinChat.signInToPost")}
            </button>
          ) : !isPaid ? (
            <button type="button" className="coin-chat-empty-cta" onClick={() => onOpenUpgrade?.("pro")}>
              {t("coinChat.upgradeToPost")}
            </button>
          ) : null}
        </div>
      ) : (
        comments.map((c) => (
          <div className="coin-chat-comment" key={c.id}>
            <div className={`coin-chat-avatar cc-tier--${c.tier}`}>{initials(c.username)}</div>
            <p className="coin-chat-comment-line">
              <span className="coin-chat-comment-name">@{c.username}</span>{" "}
              <span className={`coin-chat-tier-chip cc-tier--${c.tier}`}>{c.tier === "elite" ? "E" : "P"}</span>{" "}
              <span className="coin-chat-comment-text">{c.body}</span>{" "}
              <span className="coin-chat-comment-time">{timeAgo(c.created_at)}</span>
              {user && (
                <span className="coin-chat-comment-menu-wrap">
                  <button
                    type="button"
                    className={`coin-chat-comment-dots${openMenuId === c.id ? " coin-chat-comment-dots--open" : ""}`}
                    onClick={() => setOpenMenuId(openMenuId === c.id ? null : c.id)}
                    aria-label="More"
                  >
                    ⋮
                  </button>
                  {openMenuId === c.id && (
                    <span className="coin-chat-comment-menu">
                      {user.id === c.user_id ? (
                        <button type="button" onClick={() => { handleDelete(c.id); setOpenMenuId(null); }}>
                          {t("coinChat.delete")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={reportedIds.has(c.id)}
                          onClick={() => { handleReport(c.id); setOpenMenuId(null); }}
                        >
                          {reportedIds.has(c.id) ? t("coinChat.reported") : t("coinChat.report")}
                        </button>
                      )}
                    </span>
                  )}
                </span>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );

  const composer = (
    <div className="coin-chat-composer">
      {!user ? (
        <button type="button" className="coin-chat-cta" onClick={onOpenAuth}>{t("coinChat.signInToPost")}</button>
      ) : !isPaid ? (
        <div className="coin-chat-locked">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <span className="coin-chat-locked-text">{t("coinChat.upgradeToPost")}</span>
          <button type="button" className="coin-chat-upgrade-pill" onClick={() => onOpenUpgrade?.("pro")}>{t("coinChat.upgrade")}</button>
        </div>
      ) : (
        <div className="coin-chat-input-row">
          <input
            className="coin-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("coinChat.placeholder", { coin })}
            maxLength={COIN_COMMENT_MAX_LENGTH}
            onKeyDown={(e) => { if (e.key === "Enter") handlePost(); }}
          />
          <button type="button" className="coin-chat-send" onClick={handlePost} disabled={posting || !draft.trim()}>
            {t("coinChat.post")}
          </button>
        </div>
      )}
      {error && <p className="coin-chat-error">{error}</p>}
    </div>
  );

  // Desktop: plain content dropped into the parent's side-panel dock — no
  // trigger/backdrop/self-close, the aside wrapper in App.tsx owns visibility.
  if (isDesktop) {
    return (
      <div className="coin-chat-card">
        <div className="coin-chat-head">
          <div>
            <div className="coin-chat-title">{t("coinChat.title", { coinName: coinName(coin) })}</div>
            <div className="coin-chat-sub">{t("coinChat.commentCount", { count: comments.length })}</div>
          </div>
          <button type="button" className="coin-chat-close" onClick={() => onCloseDesktop?.()} aria-label="Close">✕</button>
        </div>
        <CoinMarketMood coin={coin} />
        {feed}
        {composer}
      </div>
    );
  }

  // Mobile: floating trigger pill + backdrop + swipe-up sheet.
  return (
    <div className={`coin-chat${sheetOpen ? " coin-chat--sheet-open" : ""}`}>
      <button type="button" className="coin-chat-trigger" onClick={() => setSheetOpen(true)}>
        <span className="coin-chat-trigger-icon">💬</span>
        <span className="coin-chat-trigger-label">{t("coinChat.triggerCount", { count: comments.length, coin })}</span>
      </button>

      <div className="coin-chat-backdrop" onClick={() => setSheetOpen(false)} />

      <div className="coin-chat-panel" ref={panelRef}>
        <div className="coin-chat-grabber" onClick={() => setSheetOpen(false)} />
        <div className="coin-chat-head">
          <div>
            <div className="coin-chat-title">{t("coinChat.title", { coinName: coinName(coin) })}</div>
            <div className="coin-chat-sub">{t("coinChat.commentCount", { count: comments.length })}</div>
          </div>
          <button type="button" className="coin-chat-close" onClick={() => setSheetOpen(false)} aria-label="Close">✕</button>
        </div>
        <CoinMarketMood coin={coin} />
        {feed}
        {composer}
      </div>
    </div>
  );
}
