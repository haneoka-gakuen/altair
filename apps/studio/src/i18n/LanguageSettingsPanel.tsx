import { useState } from "react";
import { StudioIcon } from "../StudioIcon";
import { STUDIO_UI_LOCALE_OPTIONS, projectLocaleDisplayName } from "./catalogs";
import { useStudioI18n } from "./context";
import {
  addProjectLanguage,
  moveProjectLanguage,
  removeProjectLanguage,
  setDefaultProjectLanguage,
  setProjectLanguageFallbacks,
  setProjectLanguageFonts,
  splitFontPreferences,
  type ProjectLocalization,
  type ProjectLocalizationError,
} from "./project-localization";

export interface LanguageSettingsPanelProps {
  readonly settings: ProjectLocalization;
  readonly onChange: (settings: ProjectLocalization) => void;
  readonly onClose: () => void;
  readonly disabled?: boolean;
}

export function LanguageSettingsPanel({ settings, onChange, onClose, disabled = false }: LanguageSettingsPanelProps) {
  const { locale: uiLocale, setLocale: setUiLocale, t } = useStudioI18n();
  const [candidate, setCandidate] = useState("");
  const [error, setError] = useState("");

  const add = (): void => {
    try {
      onChange(addProjectLanguage(settings, candidate));
      setCandidate("");
      setError("");
    } catch (cause) {
      const code = (cause as ProjectLocalizationError).code;
      setError(
        code === "duplicate-locale" ? t("languageAlreadyAdded", { locale: candidate.trim() }) : t("invalidLanguageTag"),
      );
    }
  };

  return (
    <section
      aria-modal="true"
      aria-labelledby="project-language-heading"
      className="language-settings"
      data-project-localization="org.haneoka.altair.localization"
      role="dialog"
    >
      <header>
        <div>
          <h2 id="project-language-heading">{t("title")}</h2>
          <p>{t("description")}</p>
        </div>
        <button aria-label={t("close")} onClick={onClose} title={t("close")} type="button">
          <StudioIcon name="close" />
        </button>
      </header>

      <label className="language-settings-ui">
        <span>{t("interfaceLanguage")}</span>
        <select onChange={(event) => setUiLocale(event.target.value as typeof uiLocale)} value={uiLocale}>
          {STUDIO_UI_LOCALE_OPTIONS.map(({ locale, label }) => (
            <option key={locale} value={locale}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <form
        className="language-settings-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label>
          <span>{t("languageTag")}</span>
          <input
            aria-invalid={Boolean(error)}
            disabled={disabled}
            onChange={(event) => setCandidate(event.target.value)}
            placeholder="fr-CA"
            value={candidate}
          />
        </label>
        <button disabled={disabled || !candidate.trim()} type="submit">
          <StudioIcon name="add" />
          <span>{t("add")}</span>
        </button>
      </form>
      {error && (
        <p className="language-settings-error" role="alert">
          {error}
        </p>
      )}

      {settings.languages.length ? (
        <ol className="project-language-list">
          {settings.languages.map((entry, index) => {
            const name = projectLocaleDisplayName(entry.locale, uiLocale);
            return (
              <li data-project-locale={entry.locale} key={entry.locale}>
                <header>
                  <div>
                    <strong>{name}</strong>
                    <code>{entry.locale}</code>
                  </div>
                  {settings.defaultLocale === entry.locale ? (
                    <span className="language-default">
                      <StudioIcon name="check" />
                      {t("defaultLanguage")}
                    </span>
                  ) : (
                    <button
                      disabled={disabled}
                      onClick={() => onChange(setDefaultProjectLanguage(settings, entry.locale))}
                      type="button"
                    >
                      {t("makeDefault")}
                    </button>
                  )}
                  <button
                    aria-label={t("moveUp", { locale: name })}
                    disabled={disabled || index === 0}
                    onClick={() => onChange(moveProjectLanguage(settings, entry.locale, -1))}
                    title={t("moveUp", { locale: name })}
                    type="button"
                  >
                    <StudioIcon name="chevron-up" />
                  </button>
                  <button
                    aria-label={t("moveDown", { locale: name })}
                    disabled={disabled || index === settings.languages.length - 1}
                    onClick={() => onChange(moveProjectLanguage(settings, entry.locale, 1))}
                    title={t("moveDown", { locale: name })}
                    type="button"
                  >
                    <StudioIcon name="chevron-down" />
                  </button>
                  <button
                    aria-label={t("removeLanguage", { locale: name })}
                    disabled={disabled}
                    onClick={() => onChange(removeProjectLanguage(settings, entry.locale))}
                    title={t("removeLanguage", { locale: name })}
                    type="button"
                  >
                    <StudioIcon name="trash" />
                  </button>
                </header>
                <fieldset>
                  <legend>{t("fallbackLanguages")}</legend>
                  <p>{t("fallbackHint")}</p>
                  <div>
                    {settings.languages
                      .filter(({ locale }) => locale !== entry.locale)
                      .map((fallback) => (
                        <label key={fallback.locale}>
                          <input
                            checked={entry.fallbackLocales.includes(fallback.locale)}
                            disabled={disabled}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...entry.fallbackLocales, fallback.locale]
                                : entry.fallbackLocales.filter((locale) => locale !== fallback.locale);
                              onChange(setProjectLanguageFallbacks(settings, entry.locale, next));
                            }}
                            type="checkbox"
                          />
                          <span>{projectLocaleDisplayName(fallback.locale, uiLocale)}</span>
                        </label>
                      ))}
                  </div>
                </fieldset>
                <label className="language-fonts">
                  <span>{t("preferredFonts")}</span>
                  <input
                    defaultValue={entry.fonts.join(", ")}
                    disabled={disabled}
                    key={`${entry.locale}:${entry.fonts.join("\0")}`}
                    onBlur={(event) =>
                      onChange(
                        setProjectLanguageFonts(settings, entry.locale, splitFontPreferences(event.target.value)),
                      )
                    }
                    placeholder={t("fontPlaceholder")}
                  />
                </label>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="language-settings-empty">{t("noLanguages")}</p>
      )}
    </section>
  );
}
