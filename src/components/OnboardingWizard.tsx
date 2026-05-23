import React, { useState } from "react";
import "../styles/OnboardingWizard.css";
import { useAuth } from "../contexts/AuthContext";
import { saveTraderLevel } from "../services/supabase";

interface Option {
  label: string;
  desc?: string;
  icon: string;
  score: number;
}

interface Question {
  id: string;
  emoji: string;
  title: string;
  subtitle: string;
  type: "single" | "multi";
  options: Option[];
}

const QUESTIONS: Question[] = [
  {
    id: "experience",
    emoji: "⏱",
    title: "How long have you been in crypto?",
    subtitle: "We'll tailor the dashboard to your experience level.",
    type: "single",
    options: [
      { label: "Just starting", desc: "Less than a month", icon: "🌱", score: 0 },
      { label: "Under a year",  desc: "Still learning the ropes", icon: "📈", score: 1 },
      { label: "1 – 3 years",   desc: "Seen a cycle or two", icon: "🔥", score: 2 },
      { label: "3+ years",      desc: "Battle-tested", icon: "⚡", score: 3 },
    ],
  },
  {
    id: "size",
    emoji: "💰",
    title: "What's your typical position size?",
    subtitle: "Helps us contextualise liquidation and risk data.",
    type: "single",
    options: [
      { label: "Under $1,000",    desc: "Getting started small", icon: "💵", score: 0 },
      { label: "$1K – $10K",      desc: "Steady accumulator",    icon: "💳", score: 1 },
      { label: "$10K – $100K",    desc: "Serious player",        icon: "🏦", score: 2 },
      { label: "$100K+",          desc: "Whale territory",       icon: "🐋", score: 3 },
    ],
  },
  {
    id: "tools",
    emoji: "🛠",
    title: "Which tools do you actively use?",
    subtitle: "Select all that apply — pick as many as you want.",
    type: "multi",
    options: [
      { label: "Spot Trading",          desc: "Buy and sell coins directly",   icon: "🔄", score: 0 },
      { label: "Futures & Leverage",    desc: "Long / short with margin",      icon: "📊", score: 1 },
      { label: "DeFi & Yield",          desc: "Liquidity pools, staking",      icon: "🌐", score: 1 },
      { label: "Options & Derivatives", desc: "Structured products",           icon: "🎯", score: 2 },
      { label: "On-chain Analysis",     desc: "Wallet flows, mempool",         icon: "🔗", score: 2 },
    ],
  },
  {
    id: "strategy",
    emoji: "🎯",
    title: "What's your primary strategy?",
    subtitle: "No wrong answers — just helps us frame the data.",
    type: "single",
    options: [
      { label: "Buy & Hold",          desc: "Long-term accumulation",   icon: "💎", score: 0 },
      { label: "Swing Trading",       desc: "Days to weeks",            icon: "🌊", score: 1 },
      { label: "Day Trading",         desc: "Multiple trades per day",  icon: "⚡", score: 2 },
      { label: "Algorithmic / Quant", desc: "Systems & automation",     icon: "🤖", score: 3 },
    ],
  },
];

const LEVELS = [
  {
    id: "beginner",
    label: "Beginner",
    color: "#22c55e",
    icon: "🌱",
    desc: "You're just getting started. We'll highlight the most important signals and keep the noise down so you can build confidence step by step.",
  },
  {
    id: "intermediate",
    label: "Intermediate",
    color: "#f59e0b",
    icon: "📈",
    desc: "You've got the basics down. We'll surface deeper market signals, funding rate context, and multi-timeframe analysis.",
  },
  {
    id: "advanced",
    label: "Advanced",
    color: "#6366f1",
    icon: "🔥",
    desc: "You know your way around. Full data access, all tools unlocked — liquidation maps, on-chain metrics, Gann analysis.",
  },
  {
    id: "expert",
    label: "Expert",
    color: "#fb7185",
    icon: "⚡",
    desc: "You eat liquidation heatmaps for breakfast. Maximum data density, zero hand-holding, pure signal.",
  },
];

function getLevel(score: number) {
  if (score <= 3)  return LEVELS[0];
  if (score <= 6)  return LEVELS[1];
  if (score <= 9)  return LEVELS[2];
  return LEVELS[3];
}

interface Props {
  onComplete: (level: string) => void;
}

export const OnboardingWizard: React.FC<Props> = ({ onComplete }) => {
  const { user, refreshProfile } = useAuth();
  const [step, setStep]               = useState(-1);
  const [scores, setScores]           = useState<number[]>([]);
  const [multiSel, setMultiSel]       = useState<number[]>([]);
  const [animKey, setAnimKey]         = useState(0);
  // Per-step history so back button can undo exactly what was added
  const [stepHistory, setStepHistory] = useState<{ scores: number[]; sel: number[] }[]>([]);

  const isDone = step === QUESTIONS.length;
  const q      = step >= 0 && !isDone ? QUESTIONS[step] : null;
  const total  = scores.reduce((a, b) => a + b, 0);
  const level  = getLevel(total);
  const pct    = step < 0 ? 0 : (step / QUESTIONS.length) * 100;

  const goTo = (nextStep: number, addScores: number[] = []) => {
    setStepHistory(prev => [...prev, { scores: addScores, sel: multiSel }]);
    setScores(prev => [...prev, ...addScores]);
    setMultiSel([]);
    setAnimKey(k => k + 1);
    setStep(nextStep);
  };

  const goBack = () => {
    const prev = stepHistory[stepHistory.length - 1];
    if (!prev) return;
    setStepHistory(h => h.slice(0, -1));
    setScores(s => s.slice(0, s.length - prev.scores.length));
    setMultiSel(prev.sel);
    setAnimKey(k => k + 1);
    setStep(s => s - 1);
  };

  const handleSingle = (score: number) => {
    setTimeout(() => goTo(step + 1, [score]), 150);
  };

  const handleMultiConfirm = () => {
    const qScores = multiSel.map(i => q!.options[i].score);
    goTo(step + 1, qScores);
  };

  return (
    <div className="onb-overlay">
      <div className="onb-card">

        {/* Progress bar */}
        <div className="onb-progress">
          <div className="onb-progress-fill" style={{ width: `${pct}%` }} />
        </div>

        {/* Animated content */}
        <div key={animKey} className="onb-body onb-anim">

          {/* ── Intro ────────────────────────────────── */}
          {step === -1 && (
            <div className="onb-intro">
              <div className="onb-intro-glyph">✦</div>
              <h1 className="onb-intro-title">Welcome to<br />TradingWise</h1>
              <p className="onb-intro-sub">
                Answer 4 quick questions so we can personalise your dashboard
                and surface the signals that matter most to you.
              </p>
              <button className="onb-btn-primary" onClick={() => goTo(0)}>
                Get Started <span className="onb-arrow">→</span>
              </button>
            </div>
          )}

          {/* ── Question ─────────────────────────────── */}
          {q && (
            <div className="onb-question">
              <div className="onb-step-pip">
                <button className="onb-btn-back" onClick={goBack}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back
                </button>
                {QUESTIONS.map((_, i) => (
                  <span key={i} className={`onb-pip${i === step ? " onb-pip--active" : i < step ? " onb-pip--done" : ""}`} />
                ))}
              </div>

              <div className="onb-q-emoji">{q.emoji}</div>
              <h2 className="onb-q-title">{q.title}</h2>
              <p className="onb-q-sub">{q.subtitle}</p>

              <div className={`onb-options${q.type === "multi" ? " onb-options--multi" : ""}`}>
                {q.options.map((opt, i) => {
                  const selected = q.type === "multi" && multiSel.includes(i);
                  return (
                    <button
                      key={i}
                      className={`onb-option${selected ? " onb-option--on" : ""}`}
                      onClick={() => {
                        if (q.type === "single") {
                          handleSingle(opt.score);
                        } else {
                          setMultiSel(prev =>
                            prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i]
                          );
                        }
                      }}
                    >
                      <span className="onb-opt-icon">{opt.icon}</span>
                      <span className="onb-opt-body">
                        <span className="onb-opt-label">{opt.label}</span>
                        {opt.desc && <span className="onb-opt-desc">{opt.desc}</span>}
                      </span>
                      {q.type === "multi" && (
                        <span className={`onb-opt-check${selected ? " onb-opt-check--on" : ""}`}>✓</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {q.type === "multi" && (
                <button
                  className="onb-btn-primary onb-btn-continue"
                  disabled={multiSel.length === 0}
                  onClick={handleMultiConfirm}
                >
                  Continue <span className="onb-arrow">→</span>
                </button>
              )}
            </div>
          )}

          {/* ── Result ───────────────────────────────── */}
          {isDone && (
            <div className="onb-result">
              <div className="onb-result-rings">
                <span className="onb-result-glyph" style={{ color: level.color }}>{level.icon}</span>
              </div>
              <div className="onb-result-badge" style={{ color: level.color, borderColor: level.color + "55", background: level.color + "18" }}>
                {level.label}
              </div>
              <h2 className="onb-result-title">Your trading profile</h2>
              <p className="onb-result-desc">{level.desc}</p>
              <button
                className="onb-btn-primary"
                style={{ background: level.color }}
                onClick={async () => {
                  if (user) {
                    await saveTraderLevel(user.id, level.id);
                    await refreshProfile();
                  }
                  onComplete(level.id);
                }}
              >
                Enter Dashboard <span className="onb-arrow">→</span>
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
