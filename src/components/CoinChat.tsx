import { useState, useEffect, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { COINS } from "../services/coinglass";
import {
  fetchCoinComments, fetchCommentById, postCoinComment, deleteCoinComment, reportCoinComment,
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
  // Set from outside (a tapped @mention push notification, routed through
  // App.tsx) when a specific comment should be scrolled to and flashed.
  highlightCommentId?: number | null;
  // Called once the highlight has actually been shown (or definitively
  // can't be — e.g. the comment was deleted) so App.tsx knows it's safe to
  // clear highlightCommentId. Not a fixed timer: the target may need an
  // extra network round-trip (see the direct-fetch effect below) that can
  // take longer than any reasonable guess, especially on a cold app launch.
  onHighlightDone?: () => void;
}

function coinName(symbol: string): string {
  return COINS.find((c) => c.symbol === symbol)?.name ?? symbol;
}

const PAGE_SIZE = 50;

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

export function CoinChat({ coin, onOpenAuth, onOpenUpgrade, onCloseDesktop, highlightCommentId, onHighlightDone }: Props) {
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
  const [flashId, setFlashId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const replyModalRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  // Always-current snapshot for the scroll listener below, so it doesn't
  // need comments/hasMore/loadingMore in its effect deps (which would mean
  // detaching and reattaching the listener on every fetch).
  const pageStateRef = useRef({ comments, hasMore, loadingMore });
  useEffect(() => { pageStateRef.current = { comments, hasMore, loadingMore }; });
  // onHighlightDone is a fresh inline function every App.tsx render — kept
  // in a ref (rather than an effect dep) so those effects don't re-run and
  // re-fire their cleanup every time the parent re-renders for unrelated
  // reasons.
  const onHighlightDoneRef = useRef(onHighlightDone);
  useEffect(() => { onHighlightDoneRef.current = onHighlightDone; }, [onHighlightDone]);
  const highlightFetchAttempted = useRef<number | null>(null);

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

  // capacitor.config.ts sets Keyboard resize:'none' globally, so these
  // fixed-position elements never shrink for the keyboard on their own —
  // whatever's at the bottom (the sheet's composer, the reply modal's
  // compose row) just ends up hidden underneath it. Both are inset:0 now
  // (no more max-height:78vh to fight with), so pulling each one's own
  // `bottom` up by the keyboard height is enough — `top` stays at 0 and
  // the safe-area gap under the status bar is handled once, by the
  // header's own padding-top, not duplicated here too.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (panelRef.current) panelRef.current.style.bottom = `${info.keyboardHeight}px`;
      if (replyModalRef.current) replyModalRef.current.style.bottom = `${info.keyboardHeight}px`;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (panelRef.current) panelRef.current.style.bottom = "0px";
      if (replyModalRef.current) replyModalRef.current.style.bottom = "0px";
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
    setHasMore(true);

    fetchCoinComments(coin, PAGE_SIZE).then((rows) => {
      if (cancelled) return;
      setComments(rows);
      setHasMore(rows.length === PAGE_SIZE);
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

  // Older comments are only fetched once the user actually scrolls toward
  // them — comments is DESC (newest first, oldest last) and loadMore
  // appends, so it stays that way across pages. Cursor is the oldest
  // loaded comment's created_at, not an offset (see fetchCoinComments).
  const loadMore = async () => {
    const { comments: current, hasMore: more, loadingMore: inFlight } = pageStateRef.current;
    if (inFlight || !more) return;
    const oldest = current[current.length - 1]?.created_at;
    if (!oldest) return;
    setLoadingMore(true);
    const rows = await fetchCoinComments(coin, PAGE_SIZE, oldest);
    setComments((prev) => [...prev, ...rows]);
    setHasMore(rows.length === PAGE_SIZE);
    setLoadingMore(false);
  };

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadMore();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
    // sheetOpen: on mobile {feed} only mounts once the sheet is open (it's
    // portaled), so feedRef.current is still null on first mount — this
    // needs to re-run once the sheet actually opens to pick up the ref,
    // not just when coin changes.
  }, [coin, sheetOpen]);

  // A tapped @mention push notification sets highlightCommentId from
  // outside (via App.tsx) — make sure the mobile sheet is actually open
  // so there's something to scroll within.
  useEffect(() => {
    if (highlightCommentId != null) setSheetOpen(true);
  }, [highlightCommentId]);

  // fetchCoinComments only loads the 50 most recent comments — a busy chat
  // can easily bury the tagged comment (or, for a reply, its parent — the
  // feed only renders a reply nested under its parent, so the parent has
  // to be present too) past that window. Once the normal load finishes and
  // the target still isn't there, fetch it directly by id and splice it
  // (and its parent, if any) into the feed. Guarded by a ref so a failed
  // lookup (deleted comment) doesn't retry every time comments changes.
  useEffect(() => {
    if (highlightCommentId == null || loading) return;
    if (comments.some((c) => c.id === highlightCommentId)) return;
    if (highlightFetchAttempted.current === highlightCommentId) return;
    highlightFetchAttempted.current = highlightCommentId;
    let cancelled = false;
    (async () => {
      const target = await fetchCommentById(highlightCommentId);
      if (cancelled) return;
      if (!target) { onHighlightDoneRef.current?.(); return; }
      const extra = [target];
      if (target.reply_to_id && !comments.some((c) => c.id === target.reply_to_id)) {
        const parent = await fetchCommentById(target.reply_to_id);
        if (parent) extra.push(parent);
      }
      if (!cancelled) {
        setComments((prev) => {
          const ids = new Set(prev.map((c) => c.id));
          return [...extra.filter((c) => !ids.has(c.id)), ...prev];
        });
      }
    })();
    return () => { cancelled = true; };
  }, [highlightCommentId, loading, comments]);

  // Once the target comment is actually in the loaded feed, scroll to it
  // and flash it briefly so it's easy to spot among everything else.
  useEffect(() => {
    if (highlightCommentId == null) return;
    if (!comments.some((c) => c.id === highlightCommentId)) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`coin-chat-comment-${highlightCommentId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashId(highlightCommentId);
    });
    const clear = setTimeout(() => {
      setFlashId(null);
      onHighlightDoneRef.current?.();
    }, 2200);
    return () => { cancelAnimationFrame(frame); clearTimeout(clear); };
  }, [highlightCommentId, comments]);

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
    <div
      id={`coin-chat-comment-${c.id}`}
      className={`coin-chat-comment${flashId === c.id ? " coin-chat-comment--flash" : ""}`}
      key={c.id}
    >
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
    <div className="coin-chat-feed" ref={feedRef}>
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
        <>
          {topLevelComments.map((c) => {
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
          })}
          {loadingMore && <p className="coin-chat-empty">{t("common.loading")}</p>}
        </>
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
  // ever one element holding composerInputRef at a time. Portaled straight
  // to <body> — .coin-chat-panel (the mobile sheet) has a CSS transform for
  // its slide animation, and a transform on any ancestor makes `position:
  // fixed` descendants resolve against THAT box instead of the real
  // viewport, so nesting this inside the sheet left the status-bar area
  // uncovered. Escaping to <body> sidesteps that regardless of ancestors.
  const replyModal = replyTarget && createPortal(
    <div className="coin-chat-reply-modal" ref={replyModalRef}>
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
    </div>,
    document.body
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

  // Mobile: floating trigger pill + full-screen takeover, same treatment
  // as the reply modal (portaled to <body> so no ancestor transform can
  // ever clip it to less than the real viewport again, opaque, safe-area
  // aware header). No backdrop/grabber — it covers the whole screen, so
  // there's no "outside" to tap or partial height to drag between.
  return (
    <div className="coin-chat">
      {!sheetOpen && (
        <button type="button" className="coin-chat-trigger" onClick={() => setSheetOpen(true)}>
          <span className="coin-chat-trigger-bubble">
            <span className="coin-chat-trigger-dot" />
            <span className="coin-chat-trigger-dot" />
            <span className="coin-chat-trigger-dot" />
            <span className="coin-chat-trigger-tail" />
          </span>
          <span className="coin-chat-trigger-label">{t("coinChat.triggerLabel")}</span>
        </button>
      )}

      {sheetOpen && createPortal(
        <div className="coin-chat-panel" ref={panelRef}>
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
        </div>,
        document.body
      )}
      {replyModal}
    </div>
  );
}
