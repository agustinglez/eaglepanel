import { en } from "./en";
import { es, esServer } from "./es/index";

/**
 * Internationalization, gettext style: the English text is the key. A missing translation falls back to English,
 * so a new message never shows up blank. The Spanish catalog is shared by the web UI (through i18next) and the API.
 */

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", es: "Español" };

/**
 * Languages offered in the interface. Spanish stays translated but is not offered yet: adding "es" here enables it
 * in the language selector and in browser language detection.
 */
export const ENABLED_LOCALES: readonly Locale[] = ["en"];

/** Catalogs by locale. English needs entries only for plural forms (`key_one` / `key_other`). */
export const catalogs: Record<Locale, Record<string, string>> = {
  en,
  es,
};

/** Catalogs for messages sent by the server (see translateText). */
const serverCatalogs: Record<Locale, Record<string, string>> = { en: {}, es: esServer };

export type TranslateParams = Record<string, string | number>;

/** `{{name}}` placeholders, the same syntax i18next uses on the web side. */
export function interpolate(text: string, params?: TranslateParams): string {
  if (!params) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function translate(locale: Locale, text: string, params?: TranslateParams): string {
  return interpolate(catalogs[locale][text] ?? text, params);
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<Locale, { regex: RegExp; names: string[]; template: string }[]>();

/** Keys with placeholders, as regular expressions that recover the values from an already filled-in English text. */
function patternsFor(locale: Locale) {
  let list = patterns.get(locale);
  if (!list) {
    list = Object.entries(serverCatalogs[locale])
      .filter(([key]) => key.includes("{{") && !/_(one|other)$/.test(key))
      .map(([key, template]) => {
        const names: string[] = [];
        const source = key
          .split(PLACEHOLDER)
          .map((part, index) => (index % 2 === 1 ? (names.push(part), "([\\s\\S]+?)") : escapeRegex(part)))
          .join("");
        return { regex: new RegExp(`^${source}$`), names, template };
      })
      // The most specific keys first: more literal text means fewer chances of a wrong match.
      .sort((a, b) => b.regex.source.length - a.regex.source.length);
    patterns.set(locale, list);
  }
  return list;
}

/**
 * Translates a message produced by the server (API errors, job titles and steps, preflight checks), which arrives
 * in English with its values already filled in: "Deploy shop.example.com" matches the key "Deploy {{fqdn}}".
 * Unknown text is returned unchanged.
 */
export function translateText(locale: Locale, text: string): string {
  if (locale === DEFAULT_LOCALE || !text) return text;
  const exact = serverCatalogs[locale][text];
  if (exact) return exact;
  for (const { regex, names, template } of patternsFor(locale)) {
    const match = regex.exec(text);
    if (match) {
      const params = Object.fromEntries(names.map((name, index) => [name, translateText(locale, match[index + 1]!)]));
      return interpolate(template, params);
    }
  }
  return text;
}
