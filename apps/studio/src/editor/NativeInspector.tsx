import { normalizeAdvLocalizedText } from "@haneoka/altair-plugin-adv";
import { tr } from "./i18n";
import { useState, type ReactNode } from "react";
import {
  parseAltairProjectDocument,
  parseAuthoredText,
  serializeAuthoredText,
  type JsonValue,
  type JsonObject,
} from "@haneoka/altair";
import { nativeCommands, NATIVE_PROJECT_PATH, type EditorStatement } from "./native-project";
import type { EditorSession } from "./session";
import { readLocalizedText, editLocalizedText } from "./localized-text";
import { PluginPanel } from "./PluginPanel";
import { NumberInput, StructuredTextInput as YamlField } from "@haneoka/altair-ui-react";
interface Field {
  key: string;
  label: string;
  kind: string;
  choices?: readonly {
    value: JsonValue;
    label: string;
  }[];
}
export function NativeInspector({
  statement,
  session,
  onOpenTimeline,
}: {
  statement: EditorStatement | undefined;
  session: EditorSession;
  onOpenTimeline?: () => void;
}) {
  const [editingLocale, setEditingLocale] = useState<string>();
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
  const fields: readonly Field[] = timeline
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
              durationMs: "Duration (ms)",
              ease: "Easing",
              transform: "Transform",
              noWait: "Continue immediately",
              parallel: "Parallel",
              keep: "Keep animation",
              writeDefault: "Write default transform",
              ignoreDefault: "Ignore default transform",
              perform: "Visual effect",
              enabled:
                node.type.plugin === "haneoka.altair" && node.type.name === "dialogue" ? "Dialogue visible" : "Enabled",
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
  let locales: readonly string[] = [];
  try {
    locales = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)?.text ?? "").locales;
  } catch {}
  const locale = editingLocale && locales.includes(editingLocale) ? editingLocale : (locales[0] ?? "und");
  const renderField = (field: Field): ReactNode => {
    const value =
        node.arguments[field.key] ??
        (timeline
          ? ({ durationSeconds: 0, waitForPrevious: true, cancelOnManualAdvance: false } as JsonObject)[field.key]
          : undefined),
      update = (next: JsonValue) => session.editArgument(node.id, field.key, next);
    let control: ReactNode;
    const editor = session.editorHost
      ?.contributions("property-editor")
      .find((editor) => editor.matches(node, field.key));
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
      control = <input value={String(value ?? "")} onChange={(event) => update(event.target.value)} />;
    else if (field.kind === "resource-list") {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      control = (
        <div className="localized-speakers">
          {items.map((item, index) => (
            <div className="localized-speaker" key={index}>
              <input
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
        </div>
      );
    } else control = <YamlField value={value ?? null} onChange={update} />;
    const Container = editor || ["localized-list", "resource-list"].includes(field.kind) ? "div" : "label";
    return (
      <Container className={field.kind === "boolean" ? "toggle-field" : "field"} key={`${node.id}/${field.key}`}>
        <span>{field.label}</span>
        {control}
      </Container>
    );
  };
  const primaryKeys = timeline
    ? fields.map((field) => field.key)
    : node.type.name === "Talk"
      ? ["targetTextNames", "text", "voiceRefs"]
      : fields
          .filter((field) => !["boolean", "select"].includes(field.kind))
          .slice(0, 4)
          .map((field) => field.key);
  const primary = fields.filter((field) => primaryKeys.includes(field.key)),
    advanced = fields.filter((field) => !primaryKeys.includes(field.key));
  return (
    <aside className="statement-inspector">
      <div className="panel-heading">
        <span>{statement.name}</span>
      </div>
      <div className="inspector-body">
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
    </aside>
  );
}
