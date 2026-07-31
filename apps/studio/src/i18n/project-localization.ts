import {
  cloneStoryValue,
  type StoryProject,
} from "@haneoka/altair";

export const PROJECT_LOCALIZATION_EXTENSION_KEY =
  "org.haneoka.altair.localization";

export interface ProjectLanguage {
  readonly locale: string;
  readonly fallbackLocales: readonly string[];
  readonly fonts: readonly string[];
}

export interface ProjectLocalization {
  readonly version: 1;
  readonly defaultLocale: string | null;
  readonly languages: readonly ProjectLanguage[];
}

export type ProjectLocalizationAction =
  | { readonly type: "language/add"; readonly locale: string }
  | { readonly type: "language/remove"; readonly locale: string }
  | {
      readonly type: "language/move";
      readonly locale: string;
      readonly offset: -1 | 1;
    }
  | { readonly type: "default/set"; readonly locale: string }
  | {
      readonly type: "fallbacks/set";
      readonly locale: string;
      readonly fallbacks: readonly string[];
    }
  | {
      readonly type: "fonts/set";
      readonly locale: string;
      readonly fonts: readonly string[];
    }
  | { readonly type: "replace"; readonly value: ProjectLocalization };

export class ProjectLocalizationError extends TypeError {
  constructor(
    readonly code:
      | "invalid-locale"
      | "duplicate-locale"
      | "missing-locale",
    message: string,
  ) {
    super(message);
    this.name = "ProjectLocalizationError";
  }
}

const GRANDFATHERED = new Set([
  "art-lojban",
  "cel-gaulish",
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "no-bok",
  "no-nyn",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
]);

export const canonicalizeProjectLocale = (value: string): string => {
  const trimmed = value.trim().replace(/_/gu, "-");
  if (!trimmed) {
    throw new ProjectLocalizationError(
      "invalid-locale",
      "A language tag is required",
    );
  }
  const lower = trimmed.toLowerCase();
  if (
    GRANDFATHERED.has(lower) ||
    /^x(?:-[a-z0-9]{1,8})+$/u.test(lower)
  ) {
    return lower;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    if (!canonical) throw new RangeError("empty language tag");
    return canonical;
  } catch {
    throw new ProjectLocalizationError(
      "invalid-locale",
      `'${value}' is not a valid BCP 47 language tag`,
    );
  }
};

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const splitFontPreferences = (value: string): readonly string[] =>
  unique(
    value
      .split(",")
      .map((font) => font.trim())
      .filter(Boolean),
  );

export const createProjectLocalization = (
  locale?: string,
): ProjectLocalization => {
  if (!locale) {
    return Object.freeze({
      version: 1,
      defaultLocale: null,
      languages: Object.freeze([]),
    });
  }
  const canonical = canonicalizeProjectLocale(locale);
  return Object.freeze({
    version: 1,
    defaultLocale: canonical,
    languages: Object.freeze([
      Object.freeze({
        locale: canonical,
        fallbackLocales: Object.freeze([]),
        fonts: Object.freeze([]),
      }),
    ]),
  });
};

const language = (
  locale: string,
  fallbackLocales: readonly string[] = [],
  fonts: readonly string[] = [],
): ProjectLanguage =>
  Object.freeze({
    locale,
    fallbackLocales: Object.freeze([...fallbackLocales]),
    fonts: Object.freeze([...fonts]),
  });

export const normalizeProjectLocalization = (
  value: unknown,
  legacyLocale?: string,
): ProjectLocalization => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createProjectLocalization(legacyLocale);
  }
  const candidate = value as {
    readonly version?: unknown;
    readonly defaultLocale?: unknown;
    readonly languages?: unknown;
  };
  if (candidate.version !== 1 || !Array.isArray(candidate.languages)) {
    return createProjectLocalization(legacyLocale);
  }
  const parsedLanguages: ProjectLanguage[] = [];
  for (const item of candidate.languages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as {
      readonly locale?: unknown;
      readonly fallbackLocales?: unknown;
      readonly fonts?: unknown;
    };
    if (typeof entry.locale !== "string") continue;
    let locale: string;
    try {
      locale = canonicalizeProjectLocale(entry.locale);
    } catch {
      continue;
    }
    if (parsedLanguages.some((current) => current.locale === locale)) continue;
    const fallbacks = Array.isArray(entry.fallbackLocales)
      ? entry.fallbackLocales.flatMap((fallback) => {
          if (typeof fallback !== "string") return [];
          try {
            return [canonicalizeProjectLocale(fallback)];
          } catch {
            return [];
          }
        })
      : [];
    const fonts = Array.isArray(entry.fonts)
      ? unique(entry.fonts.filter((font): font is string => typeof font === "string").map((font) => font.trim()).filter(Boolean))
      : [];
    parsedLanguages.push(language(locale, unique(fallbacks), fonts));
  }
  const configured = new Set(parsedLanguages.map(({ locale }) => locale));
  const languages = parsedLanguages.map((entry) =>
    language(
      entry.locale,
        entry.fallbackLocales.filter(
          (fallback) => fallback !== entry.locale && configured.has(fallback),
        ),
      entry.fonts,
    ),
  );
  let defaultLocale =
    typeof candidate.defaultLocale === "string"
      ? (() => {
          try {
            return canonicalizeProjectLocale(candidate.defaultLocale);
          } catch {
            return null;
          }
        })()
      : null;
  if (!defaultLocale || !configured.has(defaultLocale)) {
    defaultLocale = languages[0]?.locale ?? null;
  }
  return Object.freeze({
    version: 1,
    defaultLocale,
    languages: Object.freeze(languages),
  });
};

export const addProjectLanguage = (
  value: ProjectLocalization,
  locale: string,
): ProjectLocalization => {
  const canonical = canonicalizeProjectLocale(locale);
  if (value.languages.some((entry) => entry.locale === canonical)) {
    throw new ProjectLocalizationError(
      "duplicate-locale",
      `${canonical} is already configured`,
    );
  }
  return Object.freeze({
    version: 1,
    defaultLocale: value.defaultLocale ?? canonical,
    languages: Object.freeze([...value.languages, language(canonical)]),
  });
};

export const removeProjectLanguage = (
  value: ProjectLocalization,
  locale: string,
): ProjectLocalization => {
  const index = value.languages.findIndex((entry) => entry.locale === locale);
  if (index < 0) {
    throw new ProjectLocalizationError(
      "missing-locale",
      `${locale} is not configured`,
    );
  }
  const remaining = value.languages
    .filter((entry) => entry.locale !== locale)
    .map((entry) =>
      language(
        entry.locale,
        entry.fallbackLocales.filter((fallback) => fallback !== locale),
        entry.fonts,
      ),
    );
  const defaultLocale =
    value.defaultLocale === locale
      ? (remaining[index]?.locale ??
        remaining[index - 1]?.locale ??
        remaining[0]?.locale ??
        null)
      : value.defaultLocale;
  return Object.freeze({
    version: 1,
    defaultLocale,
    languages: Object.freeze(remaining),
  });
};

export const moveProjectLanguage = (
  value: ProjectLocalization,
  locale: string,
  offset: -1 | 1,
): ProjectLocalization => {
  const from = value.languages.findIndex((entry) => entry.locale === locale);
  if (from < 0) {
    throw new ProjectLocalizationError(
      "missing-locale",
      `${locale} is not configured`,
    );
  }
  const to = Math.max(0, Math.min(value.languages.length - 1, from + offset));
  if (from === to) return value;
  const languages = [...value.languages];
  const [entry] = languages.splice(from, 1);
  languages.splice(to, 0, entry!);
  return Object.freeze({
    ...value,
    languages: Object.freeze(languages),
  });
};

export const setDefaultProjectLanguage = (
  value: ProjectLocalization,
  locale: string,
): ProjectLocalization => {
  if (!value.languages.some((entry) => entry.locale === locale)) {
    throw new ProjectLocalizationError(
      "missing-locale",
      `${locale} is not configured`,
    );
  }
  return Object.freeze({ ...value, defaultLocale: locale });
};

export const setProjectLanguageFallbacks = (
  value: ProjectLocalization,
  locale: string,
  fallbacks: readonly string[],
): ProjectLocalization => {
  const configured = new Set(value.languages.map((entry) => entry.locale));
  if (!configured.has(locale)) {
    throw new ProjectLocalizationError(
      "missing-locale",
      `${locale} is not configured`,
    );
  }
  const normalized = unique(
    fallbacks
      .map(canonicalizeProjectLocale)
      .filter((fallback) => fallback !== locale && configured.has(fallback)),
  );
  return Object.freeze({
    ...value,
    languages: Object.freeze(
      value.languages.map((entry) =>
        entry.locale === locale
          ? language(entry.locale, normalized, entry.fonts)
          : entry,
      ),
    ),
  });
};

export const setProjectLanguageFonts = (
  value: ProjectLocalization,
  locale: string,
  fonts: readonly string[],
): ProjectLocalization => {
  if (!value.languages.some((entry) => entry.locale === locale)) {
    throw new ProjectLocalizationError(
      "missing-locale",
      `${locale} is not configured`,
    );
  }
  const normalized = unique(fonts.map((font) => font.trim()).filter(Boolean));
  return Object.freeze({
    ...value,
    languages: Object.freeze(
      value.languages.map((entry) =>
        entry.locale === locale
          ? language(entry.locale, entry.fallbackLocales, normalized)
          : entry,
      ),
    ),
  });
};

export const reduceProjectLocalization = (
  value: ProjectLocalization,
  action: ProjectLocalizationAction,
): ProjectLocalization => {
  switch (action.type) {
    case "language/add":
      return addProjectLanguage(value, action.locale);
    case "language/remove":
      return removeProjectLanguage(value, action.locale);
    case "language/move":
      return moveProjectLanguage(value, action.locale, action.offset);
    case "default/set":
      return setDefaultProjectLanguage(value, action.locale);
    case "fallbacks/set":
      return setProjectLanguageFallbacks(
        value,
        action.locale,
        action.fallbacks,
      );
    case "fonts/set":
      return setProjectLanguageFonts(value, action.locale, action.fonts);
    case "replace":
      return normalizeProjectLocalization(action.value);
  }
};

export const projectLocaleFallbackChain = (
  value: ProjectLocalization,
  locale: string,
): readonly string[] => {
  const configured = new Map(
    value.languages.map((entry) => [entry.locale, entry]),
  );
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (tag: string): void => {
    if (seen.has(tag) || !configured.has(tag)) return;
    seen.add(tag);
    output.push(tag);
    for (const fallback of configured.get(tag)!.fallbackLocales) {
      visit(fallback);
    }
  };
  visit(locale);
  if (value.defaultLocale) visit(value.defaultLocale);
  return Object.freeze(output);
};

export const readProjectLocalization = (
  project: StoryProject,
): ProjectLocalization =>
  normalizeProjectLocalization(
    project.extensions[PROJECT_LOCALIZATION_EXTENSION_KEY],
    project.meta.locale,
  );

export const writeProjectLocalization = (
  project: StoryProject,
  settings: ProjectLocalization,
): StoryProject => {
  const normalized = normalizeProjectLocalization(settings);
  const next = cloneStoryValue(project);
  next.extensions[PROJECT_LOCALIZATION_EXTENSION_KEY] =
    cloneStoryValue({
      version: normalized.version,
      defaultLocale: normalized.defaultLocale,
      languages: normalized.languages.map((entry) => ({
        locale: entry.locale,
        fallbackLocales: [...entry.fallbackLocales],
        fonts: [...entry.fonts],
      })),
    });
  if (normalized.defaultLocale) {
    next.meta.locale = normalized.defaultLocale;
  } else {
    delete next.meta.locale;
  }
  return next;
};

export class ProjectLocalizationController {
  #value: ProjectLocalization;
  #listeners = new Set<(value: ProjectLocalization) => void>();

  constructor(value: ProjectLocalization = createProjectLocalization()) {
    this.#value = normalizeProjectLocalization(value);
  }

  getSnapshot = (): ProjectLocalization => this.#value;

  subscribe = (listener: (value: ProjectLocalization) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  replace = (value: ProjectLocalization): void => {
    this.#value = normalizeProjectLocalization(value);
    for (const listener of this.#listeners) listener(this.#value);
  };

  dispatch = (action: ProjectLocalizationAction): void => {
    this.replace(reduceProjectLocalization(this.#value, action));
  };
}
