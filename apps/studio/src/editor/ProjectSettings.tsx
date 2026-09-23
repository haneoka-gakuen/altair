import { RuntimeSettings } from "./RuntimeSettings";
import { ProjectPlugins } from "./ProjectPlugins";
import { useState, useSyncExternalStore } from "react";
import { Plus, Star, Trash2 } from "lucide-react";
import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair";
import { canonicalLanguage, deviceLanguage, tr, useStudioI18n } from "./i18n";
import { NATIVE_PROJECT_PATH } from "./native-project";
import type { EditorSession } from "./session";
export function ProjectSettings({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { i18n } = useStudioI18n();
  const [language, setLanguage] = useState(deviceLanguage),
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
  const label = (code: string) => {
    try {
      return (
        new Intl.DisplayNames([i18n.resolvedLanguage ?? "en"], {
          type: "language",
        }).of(code) ?? code
      );
    } catch {
      return code;
    }
  };
  const add = () => {
    try {
      const next = canonicalLanguage(language);
      if (project.locales.some((locale) => canonicalLanguage(locale) === next))
        throw new Error(tr("This language is already present"));
      update([...project.locales, next]);
      setLanguage("");
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
      <h3>{tr("Project languages")}</h3>
      <RuntimeSettings />
      <p>{tr("Use any BCP 47 language tag, for example fr-CA or ar.")}</p>
      <ul>
        {project.locales.map((locale, index) => (
          <li key={locale}>
            <div>
              <strong>{label(locale)}</strong>
              <code>{locale}</code>
              {index === 0 && <small>{tr("Default language")}</small>}
            </div>
            <button
              className="icon-button"
              aria-label={`${tr("Make default")} · ${locale}`}
              disabled={index === 0}
              onClick={() => update([locale, ...project.locales.filter((value) => value !== locale)])}
            >
              <Star size={15} fill={index === 0 ? "currentColor" : "none"} />
            </button>
            <button
              className="icon-button"
              aria-label={`${tr("Remove language")} · ${locale}`}
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
          add();
        }}
      >
        <input
          aria-label={tr("Language tag")}
          placeholder="fr-CA"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        />
        <button className="secondary-button" type="submit" disabled={!language.trim()}>
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
