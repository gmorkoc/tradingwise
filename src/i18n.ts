import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import tr from "./locales/tr.json";
import it from "./locales/it.json";

// Extra translation files, one per feature and language:
//   src/locales/extra/<lang>/<feature>.json  (e.g. extra/es/positionFlows.json)
// Each holds nested keys exactly like the main files and is deep-merged on
// top of them at startup — so new features (and missing translations of
// older ones) can be added without everyone editing the same huge file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tree = { [k: string]: any };
const extraFiles = import.meta.glob<{ default: Tree }>("./locales/extra/*/*.json", { eager: true });

function deepMerge(base: Tree, add: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(add)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
      ? deepMerge(cur as Tree, v as Tree)
      : v;
  }
  return out;
}

function withExtras(lang: string, base: Tree): Tree {
  let merged = base;
  for (const [path, mod] of Object.entries(extraFiles)) {
    if (path.split("/")[3] === lang) merged = deepMerge(merged, mod.default);
  }
  return merged;
}

const savedLang = (() => {
  try { return localStorage.getItem("lang") || "en"; } catch { return "en"; }
})();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: withExtras("en", en as Tree) },
    es: { translation: withExtras("es", es as Tree) },
    tr: { translation: withExtras("tr", tr as Tree) },
    it: { translation: withExtras("it", it as Tree) },
  },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
