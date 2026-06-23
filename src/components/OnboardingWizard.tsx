import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/OnboardingWizard.css";
import { useAuth } from "../contexts/AuthContext";
import { saveTraderLevel } from "../services/supabase";

interface Option {
  icon: string;
  score: number;
}

interface Question {
  id: string;
  emoji: string;
  type: "single" | "multi";
  options: Option[];
}

const QUESTIONS: Question[] = [
  {
    id: "experience",
    emoji: "⏱",
    type: "single",
    options: [
      { icon: "🌱", score: 0 },
      { icon: "📈", score: 1 },
      { icon: "🔥", score: 2 },
      { icon: "⚡", score: 3 },
    ],
  },
  {
    id: "size",
    emoji: "💰",
    type: "single",
    options: [
      { icon: "💵", score: 0 },
      { icon: "💳", score: 1 },
      { icon: "🏦", score: 2 },
      { icon: "🐋", score: 3 },
    ],
  },
  {
    id: "tools",
    emoji: "🛠",
    type: "multi",
    options: [
      { icon: "🔄", score: 0 },
      { icon: "📊", score: 1 },
      { icon: "🌐", score: 1 },
      { icon: "🎯", score: 2 },
      { icon: "🔗", score: 2 },
    ],
  },
  {
    id: "strategy",
    emoji: "🎯",
    type: "single",
    options: [
      { icon: "💎", score: 0 },
      { icon: "🌊", score: 1 },
      { icon: "⚡", score: 2 },
      { icon: "🤖", score: 3 },
    ],
  },
];

const LEVEL_META = [
  { id: "beginner",     color: "#22c55e", icon: "🌱" },
  { id: "intermediate", color: "#f59e0b", icon: "📈" },
  { id: "advanced",     color: "#6366f1", icon: "🔥" },
  { id: "expert",       color: "#fb7185", icon: "⚡" },
];

function getLevelIndex(score: number): number {
  if (score <= 3)  return 0;
  if (score <= 6)  return 1;
  if (score <= 9)  return 2;
  return 3;
}

interface Props {
  onComplete: (level: string) => void;
  onSkip?: () => void;
}

export const ONB_NEVER_KEY = "onb_never_show";

export const OnboardingWizard: React.FC<Props> = ({ onComplete, onSkip }) => {
  const { t } = useTranslation();
  const { user, refreshProfile } = useAuth();
  const [step, setStep]               = useState(-1);
  const [scores, setScores]           = useState<number[]>([]);
  const [multiSel, setMultiSel]       = useState<number[]>([]);
  const [animKey, setAnimKey]         = useState(0);
  const [stepHistory, setStepHistory] = useState<{ scores: number[]; sel: number[] }[]>([]);

  const questions = t("onboarding.questions", { returnObjects: true }) as { title: string; subtitle: string; options: { label: string; desc?: string }[] }[];
  const levels    = t("onboarding.levels",    { returnObjects: true }) as { label: string; desc: string }[];

  const isDone = step === QUESTIONS.length;
  const q      = step >= 0 && !isDone ? QUESTIONS[step] : null;
  const total  = scores.reduce((a, b) => a + b, 0);
  const levelIdx = getLevelIndex(total);
  const levelMeta = LEVEL_META[levelIdx];
  const levelLocale = levels[levelIdx] ?? { label: "", desc: "" };
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

  const qLocale = q && questions[step] ? questions[step] : null;

  return (
    <div className="onb-overlay">
      <div className="onb-card">

        <div className="onb-progress">
          <div className="onb-progress-fill" style={{ width: `${pct}%` }} />
        </div>

        {onSkip && (
          <button className="onb-skip" onClick={onSkip} aria-label="Skip onboarding">
            Skip Now
          </button>
        )}

        <div key={animKey} className="onb-body onb-anim">

          {step === -1 && (
            <div className="onb-intro">
              <div className="onb-intro-glyph">✦</div>
              <h1 className="onb-intro-title">{t("onboarding.welcomeTitle")}</h1>
              <p className="onb-intro-sub">{t("onboarding.welcomeSub")}</p>
              <button className="onb-btn-primary" onClick={() => goTo(0)}>
                {t("onboarding.getStarted")} <span className="onb-arrow">→</span>
              </button>
              {onSkip && (
                <button
                  className="onb-never-label"
                  onClick={async () => {
                    localStorage.setItem(ONB_NEVER_KEY, "1");
                    if (user) await saveTraderLevel(user.id, "skipped");
                    onSkip();
                  }}
                >
                  Don't show this again
                </button>
              )}
            </div>
          )}

          {q && qLocale && (
            <div className="onb-question">
              <div className="onb-step-pip">
                <button className="onb-btn-back" onClick={goBack}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> {t("onboarding.back")}
                </button>
                {QUESTIONS.map((_, i) => (
                  <span key={i} className={`onb-pip${i === step ? " onb-pip--active" : i < step ? " onb-pip--done" : ""}`} />
                ))}
              </div>

              <div className="onb-q-emoji">{q.emoji}</div>
              <h2 className="onb-q-title">{qLocale.title}</h2>
              <p className="onb-q-sub">{qLocale.subtitle}</p>

              <div className={`onb-options${q.type === "multi" ? " onb-options--multi" : ""}`}>
                {q.options.map((opt, i) => {
                  const optLocale = qLocale.options[i];
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
                        <span className="onb-opt-label">{optLocale?.label ?? ""}</span>
                        {optLocale?.desc && <span className="onb-opt-desc">{optLocale.desc}</span>}
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
                  {t("onboarding.continue")} <span className="onb-arrow">→</span>
                </button>
              )}
            </div>
          )}

          {isDone && (
            <div className="onb-result">
              <div className="onb-result-rings">
                <span className="onb-result-glyph" style={{ color: levelMeta.color }}>{levelMeta.icon}</span>
              </div>
              <div className="onb-result-badge" style={{ color: levelMeta.color, borderColor: levelMeta.color + "55", background: levelMeta.color + "18" }}>
                {levelLocale.label}
              </div>
              <h2 className="onb-result-title">{t("onboarding.resultTitle")}</h2>
              <p className="onb-result-desc">{levelLocale.desc}</p>
              <button
                className="onb-btn-primary"
                style={{ background: levelMeta.color }}
                onClick={async () => {
                  if (user) {
                    await saveTraderLevel(user.id, levelMeta.id);
                    await refreshProfile();
                  }
                  onComplete(levelMeta.id);
                }}
              >
                {t("onboarding.enterDashboard")} <span className="onb-arrow">→</span>
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
