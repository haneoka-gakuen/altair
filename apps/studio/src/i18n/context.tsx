import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveStudioUiLocale, studioMessage, type StudioUiLocale, type StudioUiMessageKey } from "./catalogs";

const STORAGE_KEY = "org.haneoka.altair.ui-language";

interface StudioI18nValue {
  readonly locale: StudioUiLocale;
  readonly setLocale: (locale: StudioUiLocale) => void;
  readonly t: (key: StudioUiMessageKey, values?: Readonly<Record<string, string>>) => string;
}

const StudioI18nContext = createContext<StudioI18nValue | null>(null);

const initialLocale = (): StudioUiLocale => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return resolveStudioUiLocale(stored);
    return resolveStudioUiLocale(window.navigator.languages);
  } catch {
    return "en";
  }
};

export function StudioI18nProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocale] = useState<StudioUiLocale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // The interface locale still applies when storage is unavailable.
    }
  }, [locale]);
  const value = useMemo<StudioI18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => studioMessage(locale, key, values),
    }),
    [locale],
  );
  return <StudioI18nContext.Provider value={value}>{children}</StudioI18nContext.Provider>;
}

export const useStudioI18n = (): StudioI18nValue => {
  const value = useContext(StudioI18nContext);
  if (!value) {
    throw new ReferenceError("useStudioI18n must be used inside StudioI18nProvider");
  }
  return value;
};
