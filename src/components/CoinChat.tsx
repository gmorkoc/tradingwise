import { useState, useEffect, useRef, Fragment } from "react";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { COINS } from "../services/coinglass";
import {
  fetchCoinComments, postCoinComment, deleteCoinComment, reportCoinComment,
  likeComment, unlikeComment, fetchMyLikedCommentIds,
  subscribeToCoinComments, unsubscribeFromCoinComments, searchUsernames, COIN_COMMENT_MAX_LENGTH,
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

// Finds the @handle currently being typed at the caret, if any — e.g.
// "hey @ro|" (| = caret) -> "ro". Null once the token is broken by a
// space, or the "@" isn't starting a fresh word (like an email address).
function currentMentionQuery(value: string, caret: number): string | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  const between = upToCaret.slice(at + 1);
  if (/[^A-Za-z0-9_]/.test(between)) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(upToCaret[at - 1])) return null;
  return between;
}

// Splits on @handles (same 3-20 char pattern the server resolves) so they
// can be styled — odd indices are always the captured matches here since
// there's exactly one capturing group in the split regex.
function renderWithMentions(body: string) {
  return body.split(/(@[A-Za-z0-9_]{3,20})/g).map((part, i) =>
    i % 2 === 1 ? <span key={i} className="coin-chat-mention">{part}</span> : part
  );
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
  const { user, tier, profile } = useAuth();
  const isPaid = tier === "pro" || tier === "elite";
  const isDesktop = useIsDesktop();

  const [comments, setComments] = useState<CoinComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false); // mobile swipe-up sheet only
  const [reportedIds, setReportedIds] = useState<Set<number>>(new Set());
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<CoinComment | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);

  // Lets other floating widgets (Daily Brief) hide themselves while the
  // mobile sheet or the full-screen reply takeover is open, instead of
  // stacking/overlapping it. Desktop's docked panel doesn't share screen
  // space with those, so it isn't counted as "active" here.
  const isActive = sheetOpen || replyTarget !== null;
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("coin-chat-active", { detail: isActive }));
    return () => { if (isActive) window.dispatchEvent(new CustomEvent("coin-chat-active", { detail: false })); };
  }, [isActive]);

  useEffect(() => {
    if (mentionQuery === null) { setMentionResults([]); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      searchUsernames(mentionQuery).then((names) => { if (!cancelled) setMentionResults(names); });
    }, 200);
    return () => { cancelled = true; clearTimeout(id); };
  }, [mentionQuery]);

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
      if (cancelled) return;
      setComments(rows);
      setLoading(false);
      if (user) {
        fetchMyLikedCommentIds(user.id, rows.map((r) => r.id)).then((ids) => {
          if (!cancelled) setLikedIds(ids);
        });
      } else {
        setLikedIds(new Set());
      }
    });

    const channel = subscribeToCoinComments(
      coin,
      (comment) => setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [comment, ...prev])),
      (id) => setComments((prev) => prev.filter((c) => c.id !== id))
    );

    return () => { cancelled = true; unsubscribeFromCoinComments(channel); };
  }, [coin, user?.id]);

  // Threads stay one level deep — replying to a reply still attaches to
  // its root ancestor, so rendering never has to handle arbitrary nesting.
  const replyToId = replyTarget ? (replyTarget.reply_to_id ?? replyTarget.id) : null;

  const handlePost = async () => {
    if (!user || !draft.trim() || posting) return;
    setPosting(true); setError("");
    try {
      await postCoinComment(coin, user.id, draft, replyToId);
      setDraft("");
      setReplyTarget(null);
    } catch (e: any) {
      setError(e.message ?? t("coinChat.postFailed"));
    }
    setPosting(false);
  };

  const openReply = (c: CoinComment) => {
    setOpenMenuId(null);
    setReplyTarget(c);
    setDraft(`@${c.username} `);
    setError("");
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const closeReply = () => {
    setReplyTarget(null);
    setDraft("");
    setMentionQuery(null);
    setError("");
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

  const handleLike = async (id: number) => {
    if (!user) { onOpenAuth?.(); return; }
    const wasLiked = likedIds.has(id);
    setLikedIds((prev) => {
      const next = new Set(prev);
      wasLiked ? next.delete(id) : next.add(id);
      return next;
    });
    setComments((prev) => prev.map((c) => (
      c.id === id ? { ...c, like_count: c.like_count + (wasLiked ? -1 : 1) } : c
    )));
    try {
      await (wasLiked ? unlikeComment(id, user.id) : likeComment(id, user.id));
    } catch {
      setLikedIds((prev) => {
        const next = new Set(prev);
        wasLiked ? next.add(id) : next.delete(id);
        return next;
      });
      setComments((prev) => prev.map((c) => (
        c.id === id ? { ...c, like_count: c.like_count + (wasLiked ? 1 : -1) } : c
      )));
    }
  };

  const selectMention = (username: string) => {
    const input = composerInputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const upToCaret = draft.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) return;
    const before = draft.slice(0, at);
    const after = draft.slice(caret);
    const next = `${before}@${username} ${after}`;
    setDraft(next);
    setMentionQuery(null);
    const pos = before.length + username.length + 2;
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(pos, pos); });
  };

  // Group into one-level threads: top-level comments in feed order, each
  // with its own replies (oldest first, like reading down a thread).
  const topLevelComments = comments.filter((c) => !c.reply_to_id);
  const repliesByParent = new Map<number, CoinComment[]>();
  for (const c of comments) {
    if (!c.reply_to_id) continue;
    const list = repliesByParent.get(c.reply_to_id) ?? [];
    list.push(c);
    repliesByParent.set(c.reply_to_id, list);
  }
  repliesByParent.forEach((list) =>
    list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  );

  const renderComment = (c: CoinComment) => (
    <div className="coin-chat-comment" key={c.id}>
      <div className={`coin-chat-avatar cc-tier--${c.tier}`}>{initials(c.username)}</div>
      <div className="coin-chat-comment-body">
        <p className="coin-chat-comment-line">
          <span className="coin-chat-comment-name">@{c.username}</span>{" "}
          <span className={`coin-chat-tier-chip cc-tier--${c.tier}`}>{c.tier === "elite" ? "E" : "P"}</span>{" "}
          <span className="coin-chat-comment-text">{renderWithMentions(c.body)}</span>{" "}
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
        <div className="coin-chat-comment-actions-row">
          <button type="button" className="coin-chat-action-btn" onClick={() => openReply(c)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            {t("coinChat.reply", "Reply")}
          </button>
          <button
            type="button"
            className={`coin-chat-action-btn${likedIds.has(c.id) ? " coin-chat-action-btn--liked" : ""}`}
            onClick={() => handleLike(c.id)}
          >
            <svg viewBox="0 0 24 24" fill={likedIds.has(c.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-6.7-4.35-9.3-8.1C1 10.4 1.5 7 4.2 5.5c2.2-1.2 4.6-.6 6 1.1l1.8 2.1 1.8-2.1c1.4-1.7 3.8-2.3 6-1.1 2.7 1.5 3.2 4.9 1.5 7.4C18.7 16.65 12 21 12 21z" />
            </svg>
            {c.like_count > 0 && <span className="coin-chat-action-count">{c.like_count}</span>}
          </button>
        </div>
      </div>
    </div>
  );

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
        topLevelComments.map((c) => {
          const replies = repliesByParent.get(c.id);
          return (
            <Fragment key={c.id}>
              {renderComment(c)}
              {replies && replies.length > 0 && (
                <div className="coin-chat-thread">
                  {replies.map((r) => renderComment(r))}
                </div>
              )}
            </Fragment>
          );
        })
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
          {mentionQuery !== null && mentionResults.length > 0 && (
            <div className="coin-chat-mention-menu">
              {mentionResults.map((name) => (
                <button
                  key={name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectMention(name); }}
                >
                  @{name}
                </button>
              ))}
            </div>
          )}
          <input
            ref={composerInputRef}
            className="coin-chat-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setMentionQuery(currentMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
            }}
            placeholder={t("coinChat.placeholder", { coin })}
            maxLength={COIN_COMMENT_MAX_LENGTH}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (mentionQuery !== null && mentionResults.length > 0) {
                  e.preventDefault();
                  selectMention(mentionResults[0]);
                } else {
                  handlePost();
                }
              } else if (e.key === "Escape" && mentionQuery !== null) {
                setMentionQuery(null);
              }
            }}
          />
          <button type="button" className="coin-chat-send" onClick={handlePost} disabled={posting || !draft.trim()}>
            {t("coinChat.post")}
          </button>
        </div>
      )}
      {error && <p className="coin-chat-error">{error}</p>}
    </div>
  );

  // X/Twitter-style full-screen reply takeover: parent message up top with
  // a connecting line down to the (reused) composer, Cancel/Post in the
  // header. Reuses {composer} rather than a second input, so there's only
  // ever one element holding composerInputRef at a time.
  const replyModal = replyTarget && (
    <div className="coin-chat-reply-modal">
      <div className="coin-chat-reply-header">
        <button type="button" className="coin-chat-reply-cancel" onClick={closeReply}>
          {t("coinChat.cancel", "Cancel")}
        </button>
        <button type="button" className="coin-chat-reply-post" onClick={handlePost} disabled={posting || !draft.trim()}>
          {t("coinChat.post")}
        </button>
      </div>
      <div className="coin-chat-reply-parent">
        <div className={`coin-chat-avatar cc-tier--${replyTarget.tier}`}>{initials(replyTarget.username)}</div>
        <div className="coin-chat-reply-parent-body">
          <div className="coin-chat-reply-parent-meta">
            <span className="coin-chat-comment-name">@{replyTarget.username}</span>
            <span className={`coin-chat-tier-chip cc-tier--${replyTarget.tier}`}>{replyTarget.tier === "elite" ? "E" : "P"}</span>
            <span className="coin-chat-comment-time">{timeAgo(replyTarget.created_at)}</span>
          </div>
          <p className="coin-chat-reply-parent-text">{renderWithMentions(replyTarget.body)}</p>
        </div>
      </div>
      <div className="coin-chat-reply-connector" />
      <div className="coin-chat-reply-label">
        {t("coinChat.replyingTo", "Replying to")} <b>@{replyTarget.username}</b>
      </div>
      <div className="coin-chat-reply-compose">
        <div className={`coin-chat-avatar cc-tier--${tier}`}>{initials(profile?.username ?? "?")}</div>
        {composer}
      </div>
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
        {!replyTarget && composer}
        {replyModal}
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
        {!replyTarget && composer}
        {replyModal}
      </div>
    </div>
  );
}
