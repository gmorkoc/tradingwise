import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "../contexts/AuthContext";
import {
  UserNotification, fetchNotifications, fetchUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead,
} from "../services/notifications";
import { routeNotificationTap } from "../utils/notificationRouting";
import "../styles/NotificationsCenter.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Desktop: drop down under the bell (viewport px: top edge, right gap). */
  anchor?: { top: number; right: number; arrow?: number } | null;
  // Lets FloatingNavBar's badge stay accurate even before this panel has
  // ever been opened (mount-time count) and the instant something here
  // changes it (opened/marked read) — not just while open.
  onUnreadCountChange?: (count: number) => void;
}

/** News headlines arrive HTML-encoded ("AMD&#x2019;s", "&amp;") — turn the
 *  entities back into characters (text only; nothing is rendered as HTML). */
function decodeEntities(s: string | null | undefined): string {
  if (!s || !s.includes("&")) return s ?? "";
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Text glyphs only, deliberately — same reasoning as FloatingNavBar's
// shape-primitive icons: no hand-authored SVG path to get subtly wrong.
// Matches what the push titles themselves already use server-side
// (daily-brief-push sends "📰 ..."/"🚨 Breaking").
const TYPE_ICON: Record<string, string> = {
  buy_signal: "⚡",
  price_alert: "◉",
  strategy_alert: "⚑",
  coin_mention: "@",
  daily_brief: "📰",
  breaking_news: "🚨",
  agent_watch: "🤖",
  agent_position_close: "🤖",
  upgrade_reminder: "✦",
};

function formatRelativeTime(iso: string, t: TFunction): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t("notificationsCenter.now");
  if (mins < 60) return t("notificationsCenter.minsAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notificationsCenter.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("notificationsCenter.daysAgo", { n: days });
  return new Date(iso).toLocaleDateString();
}

export function NotificationsCenter({ open, onClose, onUnreadCountChange, anchor }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [items, setItems] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);

  // Mount-time unread count — so the floating nav's badge is right even
  // before anyone has ever opened the panel (same "count badge before
  // open" convention BuySignals' own bell used).
  useEffect(() => {
    if (!user) return;
    fetchUnreadNotificationCount(user.id).then((c) => onUnreadCountChange?.(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const rows = await fetchNotifications(user.id);
    setItems(rows);
    setLoading(false);
    onUnreadCountChange?.(rows.filter((r) => !r.read).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleTapItem = (n: UserNotification) => {
    onClose();
    if (!n.read) {
      setItems((prev) => {
        const next = prev.map((p) => (p.id === n.id ? { ...p, read: true } : p));
        onUnreadCountChange?.(next.filter((p) => !p.read).length);
        return next;
      });
      markNotificationRead(n.id);
    }
    routeNotificationTap(n.data);
  };

  const handleMarkAllRead = () => {
    if (!user) return;
    setItems((prev) => prev.map((p) => ({ ...p, read: true })));
    onUnreadCountChange?.(0);
    markAllNotificationsRead(user.id);
  };

  const unreadCount = items.filter((i) => !i.read).length;

  return ReactDOM.createPortal(
    // Desktop: centered modal with a dismissible backdrop, same as
    // BuySignals' own desktop modal. Mobile (see the @media override in
    // NotificationsCenter.css): full-screen, slides down from the top —
    // the backdrop is hidden there since there's no "outside" left to
    // click, the ✕ button is the only close affordance.
    <>
      <div className="notif-backdrop" onClick={onClose} />
      <div
        className={`notif-panel${anchor ? " notif-panel--drop" : ""}`}
        style={anchor ? ({ top: anchor.top, right: anchor.right, ["--notif-arrow" as string]: `${anchor.arrow ?? 24}px` }) : undefined}
      >
        {anchor && <span className="notif-arrow" aria-hidden="true" />}
        <div className="notif-panel-header">
          <div>
            <span className="notif-panel-title">{t("notificationsCenter.title")}</span>
            <span className="notif-panel-sub">{t("notificationsCenter.sub")}</span>
          </div>
          <div className="notif-panel-header-actions">
            {unreadCount > 0 && (
              <button type="button" className="notif-mark-all" onClick={handleMarkAllRead}>{t("notificationsCenter.markAllRead")}</button>
            )}
            <button type="button" className="notif-panel-close ios-close-btn" onClick={onClose} aria-label={t("notificationsCenter.close")}>
              <span className="ios-close-btn-txt">✕</span>
              <svg className="ios-close-btn-ic" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>

        <div className="notif-list">
          {user && loading && items.length === 0 && <p className="notif-empty">{t("notificationsCenter.loading")}</p>}
          {user && !loading && items.length === 0 && (
            <p className="notif-empty">{t("notificationsCenter.empty")}</p>
          )}
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`notif-item${n.read ? "" : " notif-item--unread"}`}
              onClick={() => handleTapItem(n)}
            >
              <span className="notif-item-icon">{TYPE_ICON[n.type] ?? "🔔"}</span>
              <span className="notif-item-body">
                <span className="notif-item-title">{decodeEntities(n.title)}</span>
                <span className="notif-item-text">{decodeEntities(n.body)}</span>
              </span>
              <span className="notif-item-meta">
                {!n.read && <span className="notif-item-dot" />}
                <span className="notif-item-time">{formatRelativeTime(n.created_at, t)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}
