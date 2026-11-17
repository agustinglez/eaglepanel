import { catalogs, DEFAULT_LOCALE, ENABLED_LOCALES, translateText, type Locale } from "@eaglepanel/shared";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

/** Where the chosen language is kept in the browser. */
const STORAGE_KEY = "eaglepanel.lang";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: Object.fromEntries(ENABLED_LOCALES.map((locale) => [locale, { translation: catalogs[locale] }])),
    supportedLngs: [...ENABLED_LOCALES],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    fallbackLng: DEFAULT_LOCALE,
    // The English text is the key: no namespaces or nested keys, so ":" and "." are plain characters.
    keySeparator: false,
    nsSeparator: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    detection: { order: ["localStorage", "navigator"], lookupLocalStorage: STORAGE_KEY, caches: ["localStorage"] },
  });

function syncDocument(lng: string) {
  document.documentElement.lang = lng;
}
syncDocument(i18n.resolvedLanguage ?? DEFAULT_LOCALE);
i18n.on("languageChanged", syncDocument);

export function currentLocale(): Locale {
  const lng = (i18n.resolvedLanguage ?? DEFAULT_LOCALE).split("-")[0] as Locale;
  return (ENABLED_LOCALES as readonly string[]).includes(lng) ? lng : DEFAULT_LOCALE;
}

/**
 * Text that comes from the server (errors, job titles and steps, checks), always in English with its values filled in.
 * Call it while rendering a component that uses `useTranslation`, so it re-renders when the language changes.
 */
export function serverText(text: string): string {
  return translateText(currentLocale(), text);
}

/** Translation outside React components (toasts, helpers). Inside components, use `useTranslation`. */
export const t = i18n.t.bind(i18n);

export default i18n;
