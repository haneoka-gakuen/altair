import { useSyncExternalStore } from "react";
import { parseAltairProjectDocument, serializeAltairDocument, type JsonObject, type JsonValue } from "@haneoka/altair";
import { NATIVE_PROJECT_PATH, nativeCommands } from "./native-project";
import { VEGA_ADV_OPCODE } from "@haneoka/vega-protocol";
import { presentationTargets, storyCommandAtoms } from "@haneoka/altair-plugin-vega-preview/projection";
import type { EditorSession } from "./session";
import { NumberInput } from "@haneoka/altair-ui-react";
import { tr } from "./i18n";

const record = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function PresentationSettings({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const document = state.documents.find((document) => document.path === NATIVE_PROJECT_PATH);
  if (!document) return null;
  const project = parseAltairProjectDocument(document.text);
  const settings = record(project.runtime.presentation),
    bindings = record(settings.bindings);
  const commands = state.project?.scenes.flatMap((scene) => storyCommandAtoms(scene.commands)) ?? [];
  const actors = [
    ...new Set(
      commands
        .filter((command) => command.command === VEGA_ADV_OPCODE.In || command.command === VEGA_ADV_OPCODE.Character)
        .flatMap((command) => presentationTargets(command.fields)),
    ),
  ].filter(Boolean);
  const speakers = [
    ...new Set(
      commands.flatMap((command) => {
        if (command.command !== VEGA_ADV_OPCODE.Talk) return [];
        const names = Array.isArray(command.fields.targetTextNames)
          ? command.fields.targetTextNames
          : [command.fields.targetName];
        return names.flatMap((value) => {
          if (typeof value === "string") return value ? [value] : [];
          const localized = record(value);
          const name =
            localized[project.locales[0]!] ?? Object.values(localized).find((value) => typeof value === "string");
          return typeof name === "string" && name ? [name] : [];
        });
      }),
    ),
  ];
  const update = (patch: JsonObject) =>
    session.update(
      document.path,
      serializeAltairDocument(
        {
          ...project,
          runtime: { ...project.runtime, presentation: { ...settings, mode: "our-notes", version: 2, ...patch } },
        },
        document.text,
      ),
    );
  const shots =
    nativeCommands.find((command) => command.name === "Focus")?.fields.find((field) => field.key === "cameraDistance")
      ?.choices ?? [];
  return (
    <section className="presentation-settings">
      <h3>{tr("Presentation")}</h3>
      <label className="field">
        <span>{tr("Default direction")}</span>
        <select
          value={String(settings.cameraMode ?? "automatic")}
          onChange={(event) => update({ cameraMode: event.target.value })}
        >
          <option value="automatic">{tr("Automatic direction")}</option>
          <option value="manual">{tr("Manual direction")}</option>
        </select>
      </label>
      <label className="field">
        <span>{tr("Focus shot")}</span>
        <select
          value={typeof settings.cameraDistance === "number" ? settings.cameraDistance : 2}
          onChange={(event) => update({ cameraDistance: Number(event.target.value) })}
        >
          {shots.map((shot) => (
            <option key={String(shot.value)} value={String(shot.value)}>
              {shot.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{tr("Camera transition (s)")}</span>
        <NumberInput
          min={0}
          max={2}
          step={0.05}
          value={typeof settings.transitionSeconds === "number" ? settings.transitionSeconds : 0.35}
          onCommit={(value) => update({ transitionSeconds: value })}
        />
      </label>
      {speakers.length > 0 && (
        <details>
          <summary>{tr("Speaker bindings")}</summary>
          {speakers.map((speaker) => (
            <label className="field" key={speaker}>
              <span>{speaker}</span>
              <select
                value={typeof bindings[speaker] === "string" ? bindings[speaker] : ""}
                aria-label={`${tr("Speaker binding")} · ${speaker}`}
                onChange={(event) => update({ bindings: { ...bindings, [speaker]: event.target.value } })}
              >
                <option value="">{tr("Automatic")}</option>
                {actors.map((actor) => (
                  <option key={actor} value={actor}>
                    {actor}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </details>
      )}
    </section>
  );
}
