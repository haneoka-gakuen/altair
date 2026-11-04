import { normalizeAdvLocalizedText } from "@haneoka/altair-plugin-adv";
import { tr } from "./i18n";
import { useId, useState, type ReactNode } from "react";
import {
  parseAltairProjectDocument,
  parseAuthoredText,
  serializeAuthoredText,
  type JsonValue,
  type JsonObject,
} from "@haneoka/altair";
import { nativeCommands, nativeNodeLabel, NATIVE_PROJECT_PATH, type EditorStatement } from "./native-project";
import type { EditorSession } from "./session";
import { readLocalizedText, editLocalizedText } from "./localized-text";
import { PluginPanel } from "./PluginPanel";
import { PropertyClipEditor } from "./PropertyClipEditor";
import { AudioClipWaveform } from "./AudioClipWaveform";
import { WebGalAnimationFramesEditor } from "./WebGalAnimationFramesEditor";
import { NumberInput, StructuredTextInput as YamlField } from "@haneoka/altair-ui-react";
interface Field {
  key: string;
  label: string;
  kind: string;
  resource?: string;
  choices?: readonly {
    value: JsonValue;
    label: string;
  }[];
}
const resourceCategories: Record<string, string[]> = {
  live2d: ["live2d", "models"],
  background: ["backgrounds", "stages"],
  still: ["stills"],
  frame: ["frames"],
  effect: ["effects"],
  "post-effect": ["postEffects"],
  audio: ["sounds", "audios"],
  video: ["videos"],
  timeline: ["timelines"],
};
export function NativeInspector({
  statement,
  session,
  onOpenTimeline,
  embedded = false,
}: {
  statement: EditorStatement | undefined;
  session: EditorSession;
  onOpenTimeline?: () => void;
  embedded?: boolean;
}) {
  const [editingLocale, setEditingLocale] = useState<string>();
  const resourceListId = useId();
  if (!statement)
    return (
      <aside className="statement-inspector">
        <div className="panel-heading">{tr("Statement properties")}</div>
        <div className="empty-panel">{tr("Select a statement to edit")}</div>
      </aside>
    );
  const node = statement.node,
    definition = nativeCommands.find(
      (command) => command.name === node.type.name && node.type.plugin === "haneoka.altair-adv",
    );
  const timeline = node.type.plugin === "haneoka.altair" && node.type.name === "timeline";
  const audioClip = node.type.plugin === "haneoka.altair" && node.type.name === "audioClip";
  const animationNode =
    node.type.plugin === "haneoka.altair-webgal" &&
    ["effect.setTempAnimation", "effect.setTempAnimationV2"].includes(node.type.name);
  let fields: readonly Field[] = audioClip
    ? [
        { key: "trackName", label: tr("Audio track"), kind: "text" },
        {
          key: "category",
          label: tr("Audio category"),
          kind: "select",
          choices: [
            { value: "Bgm", label: tr("Music") },
            { value: "Se", label: tr("Sound effect") },
            { value: "Voice", label: tr("Voice") },
          ],
        },
        { key: "offsetSeconds", label: tr("Source offset (s)"), kind: "number" },
        { key: "durationSeconds", label: tr("Duration (s)"), kind: "number" },
        { key: "playbackRate", label: tr("Playback rate"), kind: "number" },
        { key: "volume", label: tr("Clip volume"), kind: "number" },
        { key: "trackVolume", label: tr("Track volume"), kind: "number" },
        { key: "fadeInSeconds", label: tr("Fade in (s)"), kind: "number" },
        { key: "fadeOutSeconds", label: tr("Fade out (s)"), kind: "number" },
        { key: "loop", label: tr("Loop"), kind: "boolean" },
        { key: "muted", label: tr("Muted"), kind: "boolean" },
      ]
    : timeline
      ? [
          { key: "durationSeconds", label: tr("Minimum duration (s)"), kind: "number" },
          { key: "waitForPrevious", label: tr("Wait for previous timeline"), kind: "boolean" },
          { key: "cancelOnManualAdvance", label: tr("Cancel on advance"), kind: "boolean" },
        ]
      : (definition?.fields.filter((field) => !field.presentOnly || Object.hasOwn(node.arguments, field.key)) ??
        Object.keys(node.arguments).map((key) => ({
          key,
          label: tr(
            (
              {
                targetName: "Target",
                target: "Target",
                clip: "Animation curves",
                sceneId: "Scene",
                targetKey: "Label",
                condition: "Condition",
                variable: "Variable",
                value: "Value",
                prompt: "Prompt",
                unlockId: "Unlock ID",
                unlockKind: "Unlock type",
                setting: "Setting",
                fontSize: "Font size",
                fontColor: "Text color",
                backgroundColor: "Background color",
                backgroundRef: "Background",
                portraitRef: "Dialogue portrait",
                imageRef: "Portrait",
                delayTime: "Duration (ms)",
                userForward: "Wait for input",
                hold: "Hold",
                durationMs: "Duration (ms)",
                ease: "Easing",
                transform: "Transform",
                frames: "Animation frames",
                noWait: "Continue immediately",
                parallel: "Parallel",
                keep: "Keep animation",
                writeDefault: "Write default transform",
                ignoreDefault: "Ignore default transform",
                perform: "Visual effect",
                enabled:
                  node.type.plugin === "haneoka.altair" && node.type.name === "dialogue"
                    ? "Dialogue visible"
                    : "Enabled",
              } as Record<string, string>
            )[key] ?? key,
          ),
          kind:
            typeof node.arguments[key] === "boolean"
              ? "boolean"
              : typeof node.arguments[key] === "number"
                ? "number"
                : typeof node.arguments[key] === "string"
                  ? "text"
                  : "json",
        })));
  if (animationNode && !fields.some((field) => field.key === "frames"))
    fields = [...fields, { key: "frames", label: tr("Animation frames"), kind: "json" }];
  fields = fields.filter(
    (field) =>
      !["sourceIdentity", "forgetSource", "sourceScene", "webgalAnimationPreset"].includes(field.key) &&
      (!animationNode || !["animationVersion", "relative", "inherit", "relativeCalc"].includes(field.key)),
  );
  let locales: readonly string[] = [];
  let manifest: ReturnType<typeof parseAltairProjectDocument> | undefined;
  try {
    manifest = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)?.text ?? "");
    locales = manifest.locales;
  } catch {}
  const locale = editingLocale && locales.includes(editingLocale) ? editingLocale : (locales[0] ?? "und");
  const renderField = (field: Field): ReactNode => {
    const resources = (resourceCategories[field.resource ?? ""] ?? []).flatMap((category) => {
      const collection = category === "postEffects" ? manifest?.runtime.postEffects : manifest?.assets[category];
      return Object.entries(collection && typeof collection === "object" ? collection : {}).flatMap(([key, asset]) => {
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
        const source = asset.sourceMetadata;
        const label =
          asset.name ??
          asset.assetName ??
          (source && typeof source === "object" && !Array.isArray(source) ? source.live2dKey : undefined) ??
          key;
        return [
          {
            value: String(asset.resourceRef ?? asset.live2dKey ?? asset.assetName ?? asset.id ?? key),
            label: String(label),
          },
        ];
      });
    });
    const listId = resources.length ? `${resourceListId}-${field.key}` : undefined;
    const resourceList = listId ? (
      <datalist id={listId}>
        {resources.map((resource) => (
          <option key={resource.value} value={resource.value}>
            {resource.label}
          </option>
        ))}
      </datalist>
    ) : null;
    const value =
        node.arguments[field.key] ??
        (timeline
          ? ({ durationSeconds: 0, waitForPrevious: true, cancelOnManualAdvance: false } as JsonObject)[field.key]
          : undefined),
      update = (next: JsonValue) => session.editArgument(node.id, field.key, next);
    let control: ReactNode;
    if (field.key === "sceneId" && node.type.plugin === "haneoka.altair-webgal") {
      control = (
        <select value={typeof value === "string" ? value : ""} onChange={(event) => update(event.target.value)}>
          {session.getSnapshot().project?.scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.name}
            </option>
          ))}
        </select>
      );
      return (
        <label className="field" key={field.key}>
          <span>{field.label}</span>
          {control}
        </label>
      );
    }
    const editor = session.editorHost
      ?.contributions("property-editor")
      .find((editor) => editor.matches(node, field.key));
    const animation = animationNode && field.key === "frames";
    if (editor)
      control = (
        <PluginPanel
          session={session}
          panelId={editor.panelId}
          path={session.getSnapshot().active}
          selection={{ nodeId: node.id, field: field.key }}
          inline
        />
      );
    else if (node.type.plugin === "haneoka.altair" && node.type.name === "propertyClip" && field.key === "clip")
      control = <PropertyClipEditor value={value} onChange={update} />;
    else if (animation) control = <WebGalAnimationFramesEditor key={node.id} session={session} nodeId={node.id} />;
    else if (field.kind === "boolean")
      control = (
        <input
          type="checkbox"
          checked={value === true || value === "true" || value === 1}
          onChange={(event) => update(event.target.checked)}
        />
      );
    else if (field.kind === "select" && field.choices)
      control = (
        <select
          value={value === undefined ? "" : JSON.stringify(value)}
          onChange={(event) => {
            if (event.target.value) update(JSON.parse(event.target.value));
          }}
        >
          <option value="">{tr("Default")}</option>
          {field.choices.map((option) => (
            <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      );
    else if (field.kind === "number")
      control = (
        <NumberInput
          min={timeline && field.key === "durationSeconds" ? 0 : undefined}
          step="any"
          value={typeof value === "number" ? value : undefined}
          onCommit={(next) => {
            if (!timeline || next >= 0) update(next);
          }}
        />
      );
    else if (field.kind === "localized-list") {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      control = (
        <div className="localized-speakers">
          {items.map((item, index) => (
            <div className="localized-speaker" key={index}>
              <input
                dir="auto"
                aria-label={`${field.label} ${index + 1}`}
                value={readLocalizedText(normalizeAdvLocalizedText(item), locale)}
                onChange={(event) =>
                  update(
                    items.map((old, at) =>
                      at === index
                        ? editLocalizedText(
                            normalizeAdvLocalizedText(old),
                            locale,
                            locales[0] ?? locale,
                            event.target.value,
                          )
                        : old,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label={tr("Remove {{p0}} {{p1}}", {
                  p0: field.label,
                  p1: index + 1,
                })}
                onClick={() => update(items.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="secondary-button" onClick={() => update([...items, { [locale]: "" }])}>
            {tr("Add speaker")}
          </button>
        </div>
      );
    } else if (field.kind === "localized-text") {
      const localized = normalizeAdvLocalizedText(value);
      const text = readLocalizedText(localized, locale),
        change = (text: string) => update(editLocalizedText(localized, locale, locales[0] ?? locale, text));
      control =
        field.key === "text" ? (
          <textarea dir="auto" rows={6} value={text} onChange={(event) => change(event.target.value)} />
        ) : (
          <input dir="auto" value={text} onChange={(event) => change(event.target.value)} />
        );
    } else if (field.kind === "text" || field.kind === "resource")
      control = (
        <>
          <input list={listId} value={String(value ?? "")} onChange={(event) => update(event.target.value)} />
          {resourceList}
        </>
      );
    else if (field.kind === "resource-list") {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      control = (
        <div className="localized-speakers">
          {items.map((item, index) => (
            <div className="localized-speaker" key={index}>
              <input
                list={listId}
                aria-label={`${field.label} ${index + 1}`}
                value={String(item ?? "")}
                onChange={(event) => update(items.map((old, at) => (at === index ? event.target.value : old)))}
              />
              <button
                type="button"
                aria-label={tr("Remove {{p0}} {{p1}}", { p0: field.label, p1: index + 1 })}
                onClick={() => update(items.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="secondary-button" onClick={() => update([...items, ""])}>
            {tr("Add resource")}
          </button>
          {resourceList}
        </div>
      );
    } else control = <YamlField value={value ?? null} onChange={update} />;
    const Container =
      editor ||
      animation ||
      (node.type.name === "propertyClip" && field.key === "clip") ||
      ["localized-list", "resource-list"].includes(field.kind)
        ? "div"
        : "label";
    return (
      <Container className={field.kind === "boolean" ? "toggle-field" : "field"} key={`${node.id}/${field.key}`}>
        <span>{field.label}</span>
        {control}
      </Container>
    );
  };
  const primaryKeys = audioClip
    ? ["trackName", "category", "offsetSeconds", "durationSeconds", "volume", "muted"]
    : timeline
      ? fields.map((field) => field.key)
      : animationNode
        ? ["targetName", "frames"]
        : node.type.name === "Talk"
          ? ["targetTextNames", "text", "voiceRefs"]
          : fields
              .filter((field) => !["boolean", "select"].includes(field.kind))
              .slice(0, 4)
              .map((field) => field.key);
  const primary = fields.filter((field) => primaryKeys.includes(field.key)),
    advanced = fields.filter((field) => !primaryKeys.includes(field.key));
  const Panel = embedded ? "section" : "aside";
  return (
    <Panel className={embedded ? "nested-dialogue-inspector" : "statement-inspector"}>
      <div className="panel-heading">
        <span>{statement.name}</span>
      </div>
      <div className="inspector-body">
        {audioClip && <AudioClipWaveform node={node} session={session} />}
        {locales.length > 1 && fields.some((field) => field.kind.startsWith("localized-")) && (
          <label className="field">
            <span>{tr("Editing language")}</span>
            <select value={locale} onChange={(event) => setEditingLocale(event.target.value)}>
              {locales.map((locale) => (
                <option key={locale} value={locale}>
                  {locale}
                </option>
              ))}
            </select>
          </label>
        )}
        {timeline && (
          <div className="timeline-overview">
            <p>{tr("{{count}} cues", { count: node.children?.length ?? 0 })}</p>
            {onOpenTimeline && (
              <button type="button" className="secondary-button" onClick={onOpenTimeline}>
                {tr("Edit timeline")}
              </button>
            )}
          </div>
        )}
        {timeline &&
          node.children
            ?.filter((child) => child.type.name === "Talk")
            .map((dialogue) => (
              <NativeInspector
                key={dialogue.id}
                embedded
                session={session}
                statement={{
                  ...statement,
                  id: dialogue.id,
                  node: dialogue,
                  dialogue,
                  name: nativeNodeLabel(dialogue),
                  kind: "dialogue",
                }}
              />
            ))}
        {timeline &&
          node.children
            ?.filter((child) => child.type.name !== "Talk")
            .map((child) => (
              <details className="argument-section" key={child.id}>
                <summary>{nativeNodeLabel(child)}</summary>
                <NativeInspector
                  embedded
                  session={session}
                  statement={{ ...statement, id: child.id, node: child, name: nativeNodeLabel(child) }}
                />
              </details>
            ))}
        {primary.map(renderField)}
        {advanced.length > 0 && (
          <details className="argument-section">
            <summary>{tr("More properties")}</summary>
            {advanced.map(renderField)}
          </details>
        )}
        <details className="argument-section">
          <summary>{tr("Node information")}</summary>
          <pre>
            {node.type.plugin}:{node.type.name}
            {"\n"}
            {node.id}
            {"\n"}schema {node.schemaVersion}
          </pre>
        </details>
      </div>
    </Panel>
  );
}
