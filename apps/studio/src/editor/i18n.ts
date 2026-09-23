import { createInstance, type ResourceLanguage } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
const KEY = "altair.interface-language.v1";
export function canonicalLanguage(value: string): string {
  const normalized = value.trim().replaceAll("_", "-");
  if (!normalized) throw new RangeError("Invalid language tag");
  return Intl.getCanonicalLocales(normalized)[0]!;
}
export function deviceLanguage(): string {
  try {
    return canonicalLanguage(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? "en");
  } catch {
    return "en";
  }
}
export function interfaceLanguageChoice(): string {
  try {
    return localStorage.getItem(KEY) || "auto";
  } catch {
    return "auto";
  }
}
const resources = { en: { studio: en }, "zh-CN": { studio: zhCN } };
const languages = new Set(Object.keys(resources));
export const availableStudioLanguages = () => [...languages];
function matchLanguage(requested: string): string | undefined {
  try {
    const tag = canonicalLanguage(requested),
      exact = [...languages].find((lang) => lang.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const target = new Intl.Locale(tag).maximize();
    return [...languages].find((lang) => {
      const candidate = new Intl.Locale(lang).maximize();
      return candidate.language === target.language && candidate.script === target.script;
    });
  } catch {
    return undefined;
  }
}
function selectedLanguage(): string {
  const choice = interfaceLanguageChoice();
  const candidates = choice === "auto" ? (globalThis.navigator?.languages ?? [deviceLanguage()]) : [choice];
  return candidates.map(matchLanguage).find(Boolean) ?? "en";
}
export const studioI18n = createInstance();
void studioI18n.use(initReactI18next).init({
  resources,
  lng: selectedLanguage(),
  fallbackLng: "en",
  defaultNS: "studio",
  ns: ["studio"],
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false, bindI18nStore: "added removed" },
});
export const tr = (key: string, values?: Record<string, unknown>): string => String(studioI18n.t(key, values));
export function useStudioI18n() {
  return useTranslation("studio", { i18n: studioI18n });
}
const synchronizeDocument = () => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = studioI18n.resolvedLanguage ?? "en";
    document.documentElement.dir = studioI18n.dir();
  }
};
studioI18n.on("languageChanged", synchronizeDocument);
synchronizeDocument();
export function selectInterfaceLanguage(value: string): void {
  const choice = value === "auto" ? "auto" : canonicalLanguage(value);
  try {
    localStorage.setItem(KEY, choice);
  } catch {}
  void studioI18n.changeLanguage(selectedLanguage());
}
export function registerStudioLanguage(locale: string, messages: ResourceLanguage): () => void {
  const language = canonicalLanguage(locale);
  if (languages.has(language)) throw new Error(`Interface language already registered: ${language}`);
  languages.add(language);
  studioI18n.addResourceBundle(language, "studio", messages, true, true);
  void studioI18n.changeLanguage(selectedLanguage());
  return () => {
    languages.delete(language);
    studioI18n.removeResourceBundle(language, "studio");
    void studioI18n.changeLanguage(selectedLanguage());
  };
}
if (typeof window !== "undefined")
  window.addEventListener("languagechange", () => {
    if (interfaceLanguageChoice() === "auto") void studioI18n.changeLanguage(selectedLanguage());
  });
