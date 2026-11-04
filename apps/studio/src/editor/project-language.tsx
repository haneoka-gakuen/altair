import type { AltairProjectDocument, JsonObject } from "@haneoka/altair/documents";
import { canonicalLanguage, tr, useStudioI18n, studioI18n } from "./i18n";

const LANGUAGE_NAMES = "haneoka.authoring.languageNames";
const languageOrder = ["ja", "en", "zh-TW", "zh-CN", "ko"];
export const projectLanguageOrder = (current = "en") => [...new Set([current, ...languageOrder])];
export const orderedProjectLocales = (locales: readonly string[], current = "en") => [
  ...new Set([...projectLanguageOrder(current).filter((locale) => locales.includes(locale)), ...locales]),
];

export function projectLanguageLabel(
  project: Pick<AltairProjectDocument, "extensions"> | undefined,
  locale: string,
  uiLocale = "en",
): string {
  const names = project?.extensions?.[LANGUAGE_NAMES];
  const name = names && typeof names === "object" && !Array.isArray(names) ? names[locale] : undefined;
  if (typeof name === "string") return name;
  if (languageOrder.includes(locale)) return tr(`projectLanguage.${locale}`);
  return new Intl.DisplayNames([uiLocale], { type: "language" }).of(locale) ?? locale;
}

export async function resolveProjectLanguage(
  choice: string,
  customName: string,
): Promise<{ tag: string; name?: string }> {
  if (choice !== "custom") return { tag: canonicalLanguage(choice) };
  const name = customName.trim();
  if (!name) throw new Error(tr("Language name is required"));
  const displayNames = new Intl.DisplayNames([studioI18n.resolvedLanguage ?? "en"], { type: "language" });
  const known = languageOrder.find((locale) =>
    [projectLanguageLabel(undefined, locale), displayNames.of(locale)].some(
      (label) => label?.toLowerCase() === name.toLowerCase(),
    ),
  );
  if (known) return { tag: known, name };
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/iu.test(name)) return { tag: canonicalLanguage(name), name };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name.normalize("NFKC").toLowerCase()));
  const id = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { tag: `und-x-${id.slice(0, 8)}-${id.slice(8)}`, name };
}

export function withProjectLanguageName(
  project: AltairProjectDocument,
  language: { tag: string; name?: string },
): AltairProjectDocument {
  if (!language.name) return project;
  const names = project.extensions?.[LANGUAGE_NAMES];
  const previous = names && typeof names === "object" && !Array.isArray(names) ? names : {};
  return {
    ...project,
    extensions: {
      ...project.extensions,
      [LANGUAGE_NAMES]: { ...previous, [language.tag]: language.name } as JsonObject,
    },
  };
}

export function ProjectLanguagePicker({
  value,
  name,
  onChange,
  onNameChange,
  label = "Project language",
  unavailable = [],
}: {
  value: string;
  name: string;
  onChange(value: string): void;
  onNameChange(value: string): void;
  label?: string;
  unavailable?: readonly string[];
}) {
  const { i18n } = useStudioI18n();
  return (
    <>
      <label className="field">
        <span>{tr(label)}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {projectLanguageOrder(i18n.resolvedLanguage).map((locale) => (
            <option key={locale} value={locale} disabled={unavailable.includes(locale)}>
              {projectLanguageLabel(undefined, locale, locale)}
            </option>
          ))}
          <option value="custom">{tr("Custom language")}</option>
        </select>
      </label>
      {value === "custom" && (
        <label className="field">
          <span>{tr("Language name")}</span>
          <input
            value={name}
            required
            maxLength={80}
            onChange={(event) => {
              event.currentTarget.setCustomValidity("");
              onNameChange(event.target.value);
            }}
            onInvalid={(event) => {
              if (!event.currentTarget.value.trim())
                event.currentTarget.setCustomValidity(tr("Language name is required"));
            }}
          />
        </label>
      )}
    </>
  );
}
