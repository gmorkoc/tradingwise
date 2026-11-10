import { useTranslation } from "react-i18next";
import { BottomSheet } from "./BottomSheet";

// "How to use Pro Vision" — shown the first time Pro Vision is switched on,
// and from the Signal check card's "How to use" link any time after.
// Texts live in the "pvGuide" translation namespace (src/locales/extra/*/pvGuide.json),
// one { title, text } per key below.

// What each piece on the chart means.
const ON_CHART = ["ribbon", "candles", "tp", "buySell", "invalidation", "spikes", "events", "sideways", "thin", "signals15m"];

const BEST_USES = ["confirm", "stop", "trend", "stretched", "money", "track", "winners"];

// Classic weak spots of chart signals — and what Pro Vision does about each.
const SAFEGUARDS = ["tiny", "choppy", "news", "shocks", "thin"];

// What no safeguard can remove.
const LIMITS = ["headlines", "past"];

const WORKFLOW = ["s1", "s2", "s3", "s4", "s5"];

export function ProVisionGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={<>{t("pvGuide.title")}</>}
      ariaLabel={t("pvGuide.title")}
      className="pvg-sheet"
      desktopModal
    >
      <div className="pvg">
        <section className="pvg-section">
          <h3 className="pvg-h">{t("pvGuide.seeingH")}</h3>
          <ul className="pvg-list">
            {ON_CHART.map((k) => (
              <li key={k} className="pvg-item">
                <span className="pvg-dot pvg-dot--blue" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{t(`pvGuide.onChart.${k}.title`)}:</strong> {t(`pvGuide.onChart.${k}.text`)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">{t("pvGuide.bestUsesH")}</h3>
          <ol className="pvg-list">
            {BEST_USES.map((k, i) => (
              <li key={k} className="pvg-item">
                <span className="pvg-num" aria-hidden="true">{i + 1}</span>
                <span className="pvg-body">
                  <strong>{t(`pvGuide.bestUses.${k}.title`)}.</strong> {t(`pvGuide.bestUses.${k}.text`)}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">{t("pvGuide.safeguardsH")}</h3>
          <ul className="pvg-list">
            {SAFEGUARDS.map((k) => (
              <li key={k} className="pvg-item">
                <span className="pvg-dot pvg-dot--green" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{t(`pvGuide.safeguards.${k}.title`)}:</strong> {t(`pvGuide.safeguards.${k}.text`)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">{t("pvGuide.limitsH")}</h3>
          <ul className="pvg-list">
            {LIMITS.map((k) => (
              <li key={k} className="pvg-item">
                <span className="pvg-dot" aria-hidden="true" />
                <span className="pvg-body">
                  <strong>{t(`pvGuide.limits.${k}.title`)}:</strong> {t(`pvGuide.limits.${k}.text`)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pvg-section">
          <h3 className="pvg-h">{t("pvGuide.workflowH")}</h3>
          <ol className="pvg-steps">
            {WORKFLOW.map((k, i) => (
              <li key={k} className="pvg-step">
                <span className="pvg-step-num" aria-hidden="true">{i + 1}</span>
                <span>{t(`pvGuide.workflow.${k}`)}</span>
              </li>
            ))}
          </ol>
        </section>

        <button type="button" className="pvg-done" onClick={onClose}>{t("pvGuide.gotIt")}</button>
      </div>
    </BottomSheet>
  );
}
