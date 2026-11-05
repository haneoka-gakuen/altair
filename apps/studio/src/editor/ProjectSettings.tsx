import { executeStudioAction } from "./studio-host";
import { InterfaceSettings } from "./preferences";
import { WebGalEngineDialog } from "./WebGalEngineDialog";
import { RuntimeSettings } from "./RuntimeSettings";
import { ProjectPlugins } from "./ProjectPlugins";
import { PresentationSettings } from "./PresentationSettings";
import { GameSettings } from "./GameSettings";
import { useState, useSyncExternalStore } from "react";
import { Plus, Star, Trash2 } from "@haneoka/altair-ui-react";
import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair";
import { canonicalLanguage, tr, useStudioI18n } from "./i18n";
import {
  ProjectLanguagePicker,
  resolveProjectLanguage,
  withProjectLanguageName,
  projectLanguageLabel,
  orderedProjectLocales,
} from "./project-language";
import { NATIVE_PROJECT_PATH } from "./native-project";
import type { EditorSession } from "./session";
export function ProjectSettings({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { i18n } = useStudioI18n();
  const [languageChoice, setLanguage] = useState<string>(),
    [customName, setCustomName] = useState(""),
    [issue, setIssue] = useState(""),
    [titleDraft, setTitleDraft] = useState<{ base: string; text: string }>();
  const document = state.documents.find((document) => document.path === NATIVE_PROJECT_PATH);
  if (!document) return <p role="alert">{tr("Project manifest is missing")}</p>;
  let project;
  try {
    project = parseAltairProjectDocument(document.text);
  } catch (error) {
    return <p role="alert">{String(error)}</p>;
  }
  const update = (locales: readonly string[]) =>
    session.update(document.path, serializeAltairDocument({ ...project, locales }, document.text));
  const language = languageChoice ?? i18n.resolvedLanguage ?? "en";
  const label = (code: string) => projectLanguageLabel(project, code, i18n.resolvedLanguage);
  const add = async () => {
    try {
      const next = await resolveProjectLanguage(language, customName);
      const currentDocument = session.document(NATIVE_PROJECT_PATH)!;
      const current = parseAltairProjectDocument(currentDocument.text);
      if (current.locales.some((locale) => canonicalLanguage(locale) === next.tag))
        throw new Error(tr("This language is already present"));
      session.update(
        currentDocument.path,
        serializeAltairDocument(
          withProjectLanguageName({ ...current, locales: [...current.locales, next.tag] }, next),
          currentDocument.text,
        ),
      );
      setLanguage(undefined);
      setCustomName("");
      setIssue("");
    } catch (error) {
      setIssue(
        error instanceof RangeError
          ? tr("Invalid language tag")
          : String(error instanceof Error ? error.message : error),
      );
    }
  };
  return (
    <section className="project-languages">
      <label className="field">
        <span>{tr("Project name")}</span>
        <input
          value={titleDraft?.base === project.title ? titleDraft.text : project.title}
          onChange={(event) => setTitleDraft({ base: project.title, text: event.target.value })}
          onBlur={() => {
            const title = titleDraft?.base === project.title ? titleDraft.text : project.title;
            if (title.trim() && title !== project.title)
              session.update(document.path, serializeAltairDocument({ ...project, title }, document.text));
            setTitleDraft(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <InterfaceSettings />
      <button className="secondary-button" onClick={() => void executeStudioAction("ai-settings")}>
        {tr("ai.services")}
      </button>
      <PresentationSettings session={session} />
      <GameSettings session={session} />
      <RuntimeSettings />
      <WebGalEngineDialog session={session} />
      <h3>{tr("Project languages")}</h3>
      <ul>
        {orderedProjectLocales(project.locales, i18n.resolvedLanguage).map((locale) => (
          <li key={locale}>
            <div>
              <strong>{label(locale)}</strong>
              {!locale.startsWith("und-x-") && <code>{locale}</code>}
              {locale === project.locales[0] && <small>{tr("Default language")}</small>}
            </div>
            <button
              className="icon-button"
              aria-label={`${tr("Make default")} · ${label(locale)}`}
              disabled={locale === project.locales[0]}
              onClick={() => update([locale, ...project.locales.filter((value) => value !== locale)])}
            >
              <Star size={15} fill={locale === project.locales[0] ? "currentColor" : "none"} />
            </button>
            <button
              className="icon-button"
              aria-label={`${tr("Remove language")} · ${label(locale)}`}
              disabled={project.locales.length === 1}
              onClick={() => update(project.locales.filter((value) => value !== locale))}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <ProjectLanguagePicker
          value={language}
          name={customName}
          onChange={setLanguage}
          onNameChange={setCustomName}
          label="Add language"
          unavailable={project.locales}
        />
        <button
          className="secondary-button"
          type="submit"
          disabled={language === "custom" ? !customName.trim() : project.locales.includes(language)}
        >
          <Plus size={14} />
          {tr("Add language")}
        </button>
      </form>
      {issue && (
        <p role="alert" className="home-error">
          {issue}
        </p>
      )}
      <ProjectPlugins session={session} />
    </section>
  );
}
