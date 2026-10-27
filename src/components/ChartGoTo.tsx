import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/ChartGoTo.css";

// "Go to" popover for the chart's range bar (calendar button). Two tabs:
//   Date         — jump the chart to one date (+ optional time)
//   Custom range — show exactly from → to
// Dates are the viewer's local time, converted to unix seconds for the
// chart. The parent does the actual chart moves and can return an error
// string (e.g. the date is older than the loaded history) to show here
// instead of closing.

interface Props {
  onClose: () => void;
  onGoToDate: (ts: number) => string | null;
  onGoToRange: (from: number, to: number) => string | null;
}

type Tab = "date" | "range";
type Field = "date" | "from" | "to";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad(n: number) { return String(n).padStart(2, "0"); }
function toYmd(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}
// "YYYY-MM-DD" + optional "HH:MM" → unix seconds (local time).
function toTs(ymd: string, hm: string, endOfDay = false): number | null {
  const d = parseYmd(ymd);
  if (!d) return null;
  const t = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (t) d.setHours(Number(t[1]), Number(t[2]), 0, 0);
  else if (endOfDay) d.setHours(23, 59, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const CalIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const ClockIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export function ChartGoTo({ onClose, onGoToDate, onGoToRange }: Props) {
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const [tab, setTab] = useState<Tab>("date");
  const [date, setDate] = useState(toYmd(today));
  const [time, setTime] = useState("");
  const [from, setFrom] = useState(toYmd(new Date(today.getTime() - 7 * 86400000)));
  const [fromTime, setFromTime] = useState("");
  const [to, setTo] = useState(toYmd(today));
  const [toTime, setToTime] = useState("");
  const [field, setField] = useState<Field>("date");
  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on Escape / click outside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [onClose]);

  useEffect(() => { setField(tab === "date" ? "date" : "from"); setError(null); }, [tab]);

  // Month grid, Monday first.
  const cells = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const out: (Date | null)[] = Array(lead).fill(null);
    for (let i = 1; i <= days; i++) out.push(new Date(view.getFullYear(), view.getMonth(), i));
    while (out.length % 7) out.push(null);
    return out;
  }, [view]);

  const nextMonthDisabled = view.getFullYear() > today.getFullYear()
    || (view.getFullYear() === today.getFullYear() && view.getMonth() >= today.getMonth());

  const selDate = parseYmd(date);
  const selFrom = parseYmd(from);
  const selTo = parseYmd(to);

  const pick = (d: Date) => {
    setError(null);
    const s = toYmd(d);
    if (field === "date") setDate(s);
    else if (field === "from") {
      setFrom(s);
      if (selTo && d > selTo) setTo(s);
      setField("to");
    } else {
      if (selFrom && d < selFrom) { setFrom(s); setTo(toYmd(selFrom)); }
      else setTo(s);
    }
  };

  // Keep the calendar showing whichever field is being edited.
  const focusField = (f: Field, value: string) => {
    setField(f);
    const d = parseYmd(value);
    if (d) setView(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const submit = () => {
    if (tab === "date") {
      const ts = toTs(date, time);
      if (ts === null) { setError("Enter a date as YYYY-MM-DD."); return; }
      if (ts > Date.now() / 1000) { setError("That date is in the future."); return; }
      const err = onGoToDate(ts);
      if (err) setError(err); else onClose();
    } else {
      const f = toTs(from, fromTime);
      const t = toTs(to, toTime, true);
      if (f === null || t === null) { setError("Enter both dates as YYYY-MM-DD."); return; }
      if (t <= f) { setError("The end has to be after the start."); return; }
      const err = onGoToRange(f, Math.min(t, Math.floor(Date.now() / 1000)));
      if (err) setError(err); else onClose();
    }
  };

  const dateInput = (f: Field, value: string, set: (v: string) => void, label?: string) => (
    <label className={`cgt-input${field === f ? " cgt-input--focus" : ""}`}>
      {label && <span className="cgt-input-label">{label}</span>}
      <input
        value={value}
        placeholder="YYYY-MM-DD"
        onFocus={() => focusField(f, value)}
        onChange={(e) => { set(e.target.value); setError(null); const d = parseYmd(e.target.value); if (d) setView(new Date(d.getFullYear(), d.getMonth(), 1)); }}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <span className="cgt-input-icon">{CalIcon}</span>
    </label>
  );
  const timeInput = (value: string, set: (v: string) => void) => (
    <label className="cgt-input cgt-input--time">
      <input
        value={value}
        placeholder="00:00"
        onChange={(e) => { set(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <span className="cgt-input-icon">{ClockIcon}</span>
    </label>
  );

  return (
    <div className="cgt" ref={rootRef} role="dialog" aria-label="Go to">
      <div className="cgt-head">
        <span className="cgt-title">Go to</span>
        <button type="button" className="cgt-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="cgt-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "date"} className={`cgt-tab${tab === "date" ? " active" : ""}`} onClick={() => setTab("date")}>Date</button>
        <button type="button" role="tab" aria-selected={tab === "range"} className={`cgt-tab${tab === "range" ? " active" : ""}`} onClick={() => setTab("range")}>Custom range</button>
        <span className={`cgt-tab-bar cgt-tab-bar--${tab}`} />
      </div>

      {tab === "date" ? (
        <div className="cgt-fields">
          {dateInput("date", date, setDate)}
          {timeInput(time, setTime)}
        </div>
      ) : (
        <div className="cgt-fields cgt-fields--range">
          <div className="cgt-fields-row">
            {dateInput("from", from, setFrom, "From")}
            {timeInput(fromTime, setFromTime)}
          </div>
          <div className="cgt-fields-row">
            {dateInput("to", to, setTo, "To")}
            {timeInput(toTime, setToTime)}
          </div>
        </div>
      )}

      <div className="cgt-cal">
        <div className="cgt-cal-head">
          <button type="button" className="cgt-cal-nav" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} aria-label="Previous month">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="cgt-cal-month">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
          <button type="button" className="cgt-cal-nav" disabled={nextMonthDisabled} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} aria-label="Next month">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
        <div className="cgt-cal-grid cgt-cal-weekdays">
          {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
        </div>
        <div className="cgt-cal-grid">
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const future = d > today;
            const isSel = tab === "date"
              ? !!selDate && sameDay(d, selDate)
              : (!!selFrom && sameDay(d, selFrom)) || (!!selTo && sameDay(d, selTo));
            const inRange = tab === "range" && !!selFrom && !!selTo && d > selFrom && d < selTo;
            const isToday = sameDay(d, today);
            return (
              <button
                type="button"
                key={i}
                disabled={future}
                className={`cgt-day${isSel ? " cgt-day--sel" : ""}${inRange ? " cgt-day--in" : ""}${isToday ? " cgt-day--today" : ""}`}
                onClick={() => pick(d)}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      {error && <p className="cgt-error">{error}</p>}

      <div className="cgt-foot">
        <button type="button" className="cgt-btn cgt-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="cgt-btn cgt-btn--primary" onClick={submit}>Go to</button>
      </div>
    </div>
  );
}
