import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import tr from "./locales/tr.json";
import it from "./locales/it.json";

const savedLang = (() => {
  try { return localStorage.getItem("lang") || "en"; } catch { return "en"; }
})();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    tr: { translation: tr },
    it: { translation: it },
  },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
