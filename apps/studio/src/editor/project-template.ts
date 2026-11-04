import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair/documents";
import { type LibraryProject, projectLibrary } from "./library";
import { NATIVE_PROJECT_PATH, normalizeImportedProject } from "./native-project";
import { tr, studioI18n, availableStudioLanguages } from "./i18n";
import { withProjectLanguageName } from "./project-language";

export async function instantiateProjectTemplate(
  template: LibraryProject,
  title: string,
  language: { tag: string; name?: string },
): Promise<LibraryProject> {
  const draft = await projectLibrary.draft(template.id);
  const documents = new Map(draft?.documents.map((doc) => [doc.path, doc.text]) ?? []);
  const files = template.files.map((file) =>
    documents.has(file.path)
      ? { ...file, blob: new Blob([documents.get(file.path)!], { type: file.blob.type }) }
      : file,
  );
  const manifest = files.find((file) => file.path === NATIVE_PROJECT_PATH);
  if (!manifest) throw new Error(tr("Project manifest is missing"));
  const source = await manifest.blob.text();
  const original = parseAltairProjectDocument(source);
  const id = crypto.randomUUID();
  const project = withProjectLanguageName(
    { ...original, id, title, locales: [...new Set([language.tag, ...original.locales])] },
    language,
  );
  return {
    id,
    name: title,
    updatedAt: Date.now(),
    ...(template.directories ? { directories: [...template.directories] } : {}),
    files: files.map((file) =>
      file === manifest
        ? { ...file, blob: new Blob([serializeAltairDocument(project, source)], { type: file.blob.type }) }
        : file,
    ),
  };
}

export async function createWebGalExample(locale: string): Promise<LibraryProject> {
  const text = studioI18n.getFixedT(
    availableStudioLanguages().includes(locale) ? locale : (studioI18n.resolvedLanguage ?? "en"),
    "studio",
  );
  const files = {
    "game/config.txt": `Game_name:WebGAL;\nDefault_Language:${locale};\n`,
    "game/scene/start.txt": [
      `:${text("example.opening")};`,
      `choose:${text("example.rehearse")}:rehearsal.txt|${text("example.listen")}:listening.txt;`,
    ].join("\n"),
    "game/scene/rehearsal.txt": `:${text("example.rehearsal")};\nchangeScene:ending.txt;\n`,
    "game/scene/listening.txt": `:${text("example.listening")};\nchangeScene:ending.txt;\n`,
    "game/scene/ending.txt": `:${text("example.ending")};\nend;\n`,
  };
  return normalizeImportedProject({
    id: crypto.randomUUID(),
    name: tr("Dialogue and choices"),
    updatedAt: Date.now(),
    files: Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([text], { type: "text/plain" }) })),
  });
}
