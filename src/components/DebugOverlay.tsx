import { useState, useEffect, useRef } from "react";
import { subscribeDebug } from "../utils/debugLog";

// Temporary on-screen auth diagnostic panel — lets us see the
// [auth]/[terms] log trail directly on-device while chasing the
// post-login sign-out bug, without needing Safari Web Inspector.
export function DebugOverlay() {
  const [lines, setLines] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeDebug(setLines), []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed", left: 8, right: 8, bottom: 8, zIndex: 999999,
        background: "rgba(10,10,20,0.92)", color: "#7CFC7C",
        fontFamily: "monospace", fontSize: 11, lineHeight: 1.4,
        borderRadius: 8, border: "1px solid #444",
        maxHeight: collapsed ? 32 : "40vh", overflow: "hidden",
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <div
        onClick={() => setCollapsed(v => !v)}
        style={{
          display: "flex", justifyContent: "space-between", padding: "6px 10px",
          color: "#fff", background: "#222", cursor: "pointer",
        }}
      >
        <span>auth debug log ({lines.length})</span>
        <span>{collapsed ? "▲ show" : "▼ hide"}</span>
      </div>
      {!collapsed && (
        <div ref={scrollRef} style={{ padding: "6px 10px", overflowY: "auto", maxHeight: "calc(40vh - 32px)" }}>
          {lines.map((l, i) => <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
