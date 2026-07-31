import type {
  AltairCommandFieldSchema,
  AltairCommandSchemaContribution,
  JsonObject,
  JsonValue,
  StoryProjectCommand,
} from "@haneoka/altair";
import type { AltairAdvService } from "@haneoka/altair-plugin-adv";
import { useEffect, useId, useMemo, useState } from "react";
import { StudioIcon } from "./StudioIcon";
import {
  replaceVisualFieldValue,
  replaceVisualLocalizedValueForLocale,
  replaceVisualVector3Axis,
  visualFieldNativeKind,
  visualFieldPlaceholder,
  visualFieldsFor,
  visualFieldValue,
  visualLocalizedValueForLocale,
  visualVector3,
  type VisualLocaleOption,
  type VisualResourceCandidate,
} from "./visual-authoring";

export interface VisualSentenceCardProps {
  readonly active: boolean;
  readonly advService?: AltairAdvService;
  readonly canRun: boolean;
  readonly command: StoryProjectCommand;
  readonly index: number;
  readonly locale: string;
  readonly locales: readonly VisualLocaleOption[];
  readonly resourceCandidates: readonly VisualResourceCandidate[];
  readonly schema?: AltairCommandSchemaContribution;
  readonly onChange: (command: StoryProjectCommand) => void;
  readonly onDropAt: (sourceIndex: number, targetIndex: number) => void;
  readonly onInsertBefore: () => void;
  readonly onRemove: () => void;
  readonly onRun: () => void;
  readonly onSelect: () => void;
}

interface FieldEditorProps {
  readonly field: AltairCommandFieldSchema;
  readonly locale: string;
  readonly locales: readonly VisualLocaleOption[];
  readonly onChange: (value: JsonValue | undefined) => void;
  readonly onFocus: () => void;
  readonly resourceCandidates: readonly VisualResourceCandidate[];
  readonly value: JsonValue | undefined;
}

const objectValue = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const displayText = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
};

const sameOption = (left: JsonValue | undefined, right: JsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right) ||
  (typeof left === "string" &&
    (typeof right === "number" || typeof right === "boolean") &&
    left === String(right));

const candidateList = (
  field: AltairCommandFieldSchema,
  candidates: readonly VisualResourceCandidate[],
): readonly VisualResourceCandidate[] => {
  const audioUsage = field.metadata?.audioUsage;
  return candidates.filter(
    ({ kind, usage }) =>
      (!field.resourceKind || kind === field.resourceKind) &&
      (typeof audioUsage !== "string" || !audioUsage || usage === audioUsage),
  );
};

function JsonField({
  field,
  onChange,
  onFocus,
  value,
}: Pick<FieldEditorProps, "field" | "onChange" | "onFocus" | "value">) {
  const serialized = useMemo(
    () => (value === undefined ? "" : JSON.stringify(value, null, 2)),
    [value],
  );
  const [text, setText] = useState(serialized);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);

  const commit = (): void => {
    if (!text.trim()) {
      setError("");
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text) as JsonValue;
      setError("");
      onChange(parsed);
    } catch (parseError) {
      setError(
        parseError instanceof Error ? parseError.message : String(parseError),
      );
    }
  };

  return (
    <details className="visual-json-field">
      <summary>
        <span>{field.label}</span>
        <small>{error || "Advanced JSON data"}</small>
      </summary>
      <label>
        <span className="sr-only">{field.label}</span>
        <textarea
          aria-invalid={Boolean(error)}
          aria-label={`${field.label} JSON`}
          onBlur={commit}
          onChange={(event) => setText(event.target.value)}
          onFocus={onFocus}
          spellCheck={false}
          value={text}
        />
      </label>
    </details>
  );
}

function LocalizedListField({
  field,
  locale,
  locales,
  onChange,
  onFocus,
  value,
}: FieldEditorProps) {
  return (
    <fieldset
      className="visual-field visual-field-wide visual-structured-field"
      onFocusCapture={onFocus}
    >
      <legend>{field.label}</legend>
      <div className="visual-locales">
        {locales.map((item) => (
          <label key={item.key}>
            <span>
              {item.label}
              {item.key === locale ? <small>Current</small> : null}
            </span>
            {field.kind === "localized-text" ? (
              <textarea
                aria-label={`${field.label} — ${item.label}`}
                lang={item.key}
                onChange={(event) => {
                  onChange(
                    replaceVisualLocalizedValueForLocale(
                      value,
                      item.key,
                      event.target.value,
                    ),
                  );
                }}
                placeholder={visualFieldPlaceholder(field)}
                rows={3}
                style={
                  item.fonts?.length
                    ? { fontFamily: item.fonts.join(", ") }
                    : undefined
                }
                value={visualLocalizedValueForLocale(value, item.key)}
              />
            ) : (
              <input
                aria-label={`${field.label} — ${item.label}`}
                lang={item.key}
                onChange={(event) => {
                  onChange(
                    replaceVisualLocalizedValueForLocale(
                      value,
                      item.key,
                      event.target.value,
                    ),
                  );
                }}
                placeholder={visualFieldPlaceholder(field)}
                style={
                  item.fonts?.length
                    ? { fontFamily: item.fonts.join(", ") }
                    : undefined
                }
                value={visualLocalizedValueForLocale(value, item.key)}
              />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Vector3Field({
  field,
  onChange,
  onFocus,
  value,
}: FieldEditorProps) {
  const vector = visualVector3(value);
  return (
    <fieldset
      className="visual-field visual-field-wide visual-structured-field"
      onFocusCapture={onFocus}
    >
      <legend>{field.label}</legend>
      <div className="visual-vector">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis}>
            <span>{axis.toUpperCase()}</span>
            <input
              aria-label={`${field.label} ${axis.toUpperCase()}`}
              onChange={(event) => {
                const coordinate = Number(event.target.value);
                if (Number.isFinite(coordinate)) {
                  onChange(replaceVisualVector3Axis(value, axis, coordinate));
                }
              }}
              step="any"
              type="number"
              value={vector[axis]}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function MultiSelectField({
  field,
  onChange,
  onFocus,
  value,
}: FieldEditorProps) {
  const options = field.options ?? [];
  const selected = Array.isArray(value) ? value : [];
  if (!options.length) {
    return (
      <JsonField
        field={field}
        onChange={onChange}
        onFocus={onFocus}
        value={value}
      />
    );
  }
  return (
    <fieldset
      className="visual-field visual-field-wide visual-structured-field"
      onFocusCapture={onFocus}
    >
      <legend>{field.label}</legend>
      <div className="visual-check-grid">
        {options.map((option, optionIndex) => {
          const checked = selected.some((item) =>
            sameOption(item, option.value),
          );
          return (
            <label key={`${optionIndex}-${option.label}`}>
              <input
                checked={checked}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, option.value]
                    : selected.filter(
                        (item) => !sameOption(item, option.value),
                      );
                  onChange(next);
                }}
                type="checkbox"
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const choiceText = (value: JsonValue | undefined, locale: string): string => {
  if (typeof value === "string") return value;
  const preferred = visualLocalizedValueForLocale(value, locale);
  if (preferred) return preferred;
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string") ?? "";
  }
  const record = objectValue(value);
  return (
    (Object.values(record ?? {}).find(
      (item): item is string => typeof item === "string",
    ) ?? "")
  );
};

const replaceChoiceText = (
  value: JsonValue | undefined,
  locale: string,
  text: string,
): JsonValue => {
  return replaceVisualLocalizedValueForLocale(value, locale, text);
};

function ChoiceListField({
  field,
  locale,
  onChange,
  onFocus,
  value,
}: FieldEditorProps) {
  const rows = Array.isArray(value) ? value : [];
  const changeRow = (
    rowIndex: number,
    key:
      | "choiceValue"
      | "text"
      | "textId"
      | "nextKey"
      | "visibleWhen"
      | "enabledWhen",
    nextValue: JsonValue | undefined,
  ): void => {
    const next = [...rows];
    const row = objectValue(rows[rowIndex]) ?? {};
    const nextRow = { ...row };
    if (nextValue === undefined) delete nextRow[key];
    else nextRow[key] = nextValue;
    next[rowIndex] = nextRow;
    onChange(next);
  };
  return (
    <fieldset
      className="visual-field visual-field-wide visual-structured-field"
      onFocusCapture={onFocus}
    >
      <legend>{field.label}</legend>
      <div className="visual-choice-list">
        {rows.map((item, rowIndex) => {
          const row = objectValue(item) ?? {};
          return (
            <div className="visual-choice-row" key={rowIndex}>
              <label>
                <span>Value</span>
                <input
                  aria-label={`${field.label} ${rowIndex + 1} value`}
                  onChange={(event) => {
                    if (!event.target.value.trim()) {
                      changeRow(rowIndex, "choiceValue", undefined);
                      return;
                    }
                    const next = Number(event.target.value);
                    if (Number.isSafeInteger(next)) {
                      changeRow(rowIndex, "choiceValue", next);
                    }
                  }}
                  step="1"
                  type="number"
                  value={displayText(row.choiceValue)}
                />
              </label>
              <label>
                <span>Text · {locale}</span>
                <input
                  aria-label={`${field.label} ${rowIndex + 1} text`}
                  onChange={(event) =>
                    changeRow(
                      rowIndex,
                      "text",
                      replaceChoiceText(
                        row.text,
                        locale,
                        event.target.value,
                      ),
                    )
                  }
                  value={choiceText(row.text, locale)}
                />
              </label>
              <label>
                <span>Destination</span>
                <input
                  aria-label={`${field.label} ${rowIndex + 1} destination`}
                  onChange={(event) =>
                    changeRow(rowIndex, "nextKey", event.target.value)
                  }
                  value={displayText(row.nextKey)}
                />
              </label>
              <button
                aria-label={`Remove choice ${rowIndex + 1}`}
                className="icon-button"
                onClick={() =>
                  onChange(rows.filter((_, index) => index !== rowIndex))
                }
                title="Remove choice"
                type="button"
              >
                <StudioIcon name="trash" />
              </button>
              <div className="visual-choice-conditions">
                <label>
                  <span>Text key</span>
                  <input
                    aria-label={`${field.label} ${rowIndex + 1} text key`}
                    onChange={(event) =>
                      changeRow(
                        rowIndex,
                        "textId",
                        event.target.value || undefined,
                      )
                    }
                    placeholder="Optional localization key"
                    value={displayText(row.textId)}
                  />
                </label>
                <label>
                  <span>Visible when</span>
                  <input
                    aria-label={`${field.label} ${rowIndex + 1} visibility condition`}
                    onChange={(event) =>
                      changeRow(
                        rowIndex,
                        "visibleWhen",
                        event.target.value || undefined,
                      )
                    }
                    placeholder="Optional expression"
                    value={displayText(row.visibleWhen)}
                  />
                </label>
                <label>
                  <span>Enabled when</span>
                  <input
                    aria-label={`${field.label} ${rowIndex + 1} availability condition`}
                    onChange={(event) =>
                      changeRow(
                        rowIndex,
                        "enabledWhen",
                        event.target.value || undefined,
                      )
                    }
                    placeholder="Optional expression"
                    value={displayText(row.enabledWhen)}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>
      <button
        className="visual-list-add"
        onClick={() => {
          const used = rows.flatMap((item) => {
            const choiceValue = objectValue(item)?.choiceValue;
            return typeof choiceValue === "number" ? [choiceValue] : [];
          });
          const nextValue = (used.length ? Math.max(...used) : 0) + 1;
          onChange([
            ...rows,
            { choiceValue: nextValue, text: "", nextKey: "" },
          ]);
        }}
        type="button"
      >
        <StudioIcon name="add" />
        Add choice
      </button>
    </fieldset>
  );
}

function ResourceListField({
  field,
  onChange,
  onFocus,
  resourceCandidates,
  value,
}: FieldEditorProps) {
  const resources = Array.isArray(value)
    ? value.map(displayText)
    : value === undefined
      ? []
      : [displayText(value)];
  const candidates = candidateList(field, resourceCandidates);
  return (
    <fieldset
      className="visual-field visual-field-wide visual-structured-field"
      onFocusCapture={onFocus}
    >
      <legend>{field.label}</legend>
      <div className="visual-resource-list">
        {resources.map((resource, index) => (
          <div key={`${index}-${resource}`}>
            <label>
              <span className="sr-only">
                {field.label} {index + 1}
              </span>
              <select
                aria-label={`${field.label} ${index + 1}`}
                onChange={(event) => {
                  const next = [...resources];
                  next[index] = event.target.value;
                  onChange(next);
                }}
                value={resource}
              >
                {resource &&
                !candidates.some(({ value: candidate }) => candidate === resource) ? (
                  <option value={resource}>{resource}</option>
                ) : null}
                {candidates.map((candidate) => (
                  <option key={candidate.value} value={candidate.value}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              aria-label={`Remove ${field.label} ${index + 1}`}
              className="icon-button"
              onClick={() =>
                onChange(resources.filter((_, itemIndex) => itemIndex !== index))
              }
              title="Remove resource"
              type="button"
            >
              <StudioIcon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <button
        className="visual-list-add"
        disabled={!candidates.length}
        onClick={() => onChange([...resources, candidates[0]?.value ?? ""])}
        type="button"
      >
        <StudioIcon name="add" />
        Add resource
      </button>
    </fieldset>
  );
}

function FieldEditor(props: FieldEditorProps) {
  const {
    field,
    locale,
    locales,
    onChange,
    onFocus,
    resourceCandidates,
    value,
  } =
    props;
  const id = useId();
  const nativeKind = visualFieldNativeKind(field);
  const placeholder = visualFieldPlaceholder(field);

  if (
    nativeKind === "localized-list" ||
    field.kind === "localized-text"
  ) {
    return <LocalizedListField {...props} />;
  }
  if (nativeKind === "vector3") return <Vector3Field {...props} />;
  if (nativeKind === "multi-select") return <MultiSelectField {...props} />;
  if (nativeKind === "choice-list") return <ChoiceListField {...props} />;
  if (nativeKind === "resource-list") return <ResourceListField {...props} />;
  if (
    field.kind === "json" ||
    ![
      "string",
      "number",
      "boolean",
      "select",
      "resource",
      "localized-text",
    ].includes(field.kind)
  ) {
    return <JsonField {...props} />;
  }
  if (field.kind === "boolean") {
    return (
      <label
        className="visual-field visual-field-boolean"
        htmlFor={id}
      >
        <input
          checked={value === true}
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          onFocus={onFocus}
          type="checkbox"
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.kind === "select") {
    const options = field.options ?? [];
    const selected = options.findIndex(({ value: candidate }) =>
      sameOption(value, candidate),
    );
    return (
      <label className="visual-field" htmlFor={id}>
        <span>{field.label}</span>
        <select
          id={id}
          onChange={(event) => {
            if (event.target.value === "") {
              onChange(field.required ? "" : undefined);
              return;
            }
            const option = options[Number(event.target.value)];
            onChange(option?.value);
          }}
          onFocus={onFocus}
          required={field.required}
          value={selected < 0 ? "" : String(selected)}
        >
          <option value="">Select…</option>
          {options.map((option, optionIndex) => (
            <option
              key={`${optionIndex}-${option.label}`}
              value={optionIndex}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "resource") {
    const current = displayText(value);
    const candidates = candidateList(field, resourceCandidates);
    return (
      <label className="visual-field" htmlFor={id}>
        <span>{field.label}</span>
        <select
          id={id}
          onChange={(event) =>
            onChange(
              event.target.value || (field.required ? "" : undefined),
            )
          }
          onFocus={onFocus}
          required={field.required}
          value={current}
        >
          <option value="">None</option>
          {current &&
          !candidates.some(({ value: candidate }) => candidate === current) ? (
            <option value={current}>{current}</option>
          ) : null}
          {candidates.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="visual-field" htmlFor={id}>
      <span>{field.label}</span>
      <input
        id={id}
        inputMode={field.kind === "number" ? "decimal" : undefined}
        onChange={(event) => {
          if (field.kind !== "number") {
            onChange(
              event.target.value || (field.required ? "" : undefined),
            );
            return;
          }
          const next = event.target.value.trim();
          if (!next) {
            onChange(undefined);
            return;
          }
          const number = Number(next);
          if (Number.isFinite(number)) onChange(number);
        }}
        onFocus={onFocus}
        placeholder={placeholder}
        required={field.required}
        step={field.kind === "number" ? "any" : undefined}
        type={field.kind === "number" ? "number" : "text"}
        value={displayText(value)}
      />
    </label>
  );
}

export function VisualSentenceCard({
  active,
  advService,
  canRun,
  command,
  index,
  locale,
  locales,
  resourceCandidates,
  schema,
  onChange,
  onDropAt,
  onInsertBefore,
  onRemove,
  onRun,
  onSelect,
}: VisualSentenceCardProps) {
  const title =
    schema?.name ??
    schema?.sourceNames?.[0] ??
    command.source?.command ??
    "Extension command";
  const description =
    schema?.category ??
    (command.command === null ? "Source extension required" : "Command");
  const fields = visualFieldsFor(command, schema, advService);
  const updateField = (
    field: AltairCommandFieldSchema,
    value: JsonValue | undefined,
  ): void => {
    onChange(replaceVisualFieldValue(command, field, value, advService));
  };

  return (
    <article
      aria-label={title}
      className={active ? "sentence active" : "sentence"}
      onDragOver={(event) => {
        if (
          Array.from(event.dataTransfer.types).includes(
            "text/x-altair-command-index",
          )
        ) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const source = event.dataTransfer.getData(
          "text/x-altair-command-index",
        );
        if (!/^(?:0|[1-9]\d*)$/u.test(source)) return;
        event.preventDefault();
        const sourceIndex = Number(source);
        if (Number.isSafeInteger(sourceIndex) && sourceIndex !== index) {
          onDropAt(sourceIndex, index);
        }
      }}
    >
      <button
        aria-label={`Select ${title}`}
        className="command-select"
        draggable
        onDragEnd={(event) =>
          event.currentTarget
            .closest(".sentence")
            ?.classList.remove("dragging")
        }
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "text/x-altair-command-index",
            String(index),
          );
          event.currentTarget
            .closest(".sentence")
            ?.classList.add("dragging");
        }}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (
            !event.altKey ||
            (event.key !== "ArrowUp" && event.key !== "ArrowDown")
          ) {
            return;
          }
          event.preventDefault();
          onDropAt(index, index + (event.key === "ArrowUp" ? -1 : 1));
        }}
        title={`Drag to reorder ${title}; Alt+Arrow keys also move it`}
      >
        <span aria-hidden="true" className="drag-handle">
          <StudioIcon name="drag" />
        </span>
        <span>
          <b>{title}</b>
          <small>{description}</small>
        </span>
      </button>

      <div className="sentence-actions">
        <button
          aria-label={`Insert command before ${title}`}
          onClick={onInsertBefore}
          title="Insert before"
        >
          <StudioIcon name="insert" />
        </button>
        <button
          aria-label={`Run ${title}`}
          disabled={!canRun}
          onClick={onRun}
          title="Run from this command"
        >
          <StudioIcon name="play" />
        </button>
        <button
          aria-label={`Delete ${title}`}
          onClick={onRemove}
          title="Delete command"
        >
          <StudioIcon name="trash" />
        </button>
      </div>

      <div className="visual-fields">
        {fields.length ? (
          fields.map((field) => (
            <FieldEditor
              field={field}
              key={field.key}
              locale={locale}
              locales={locales}
              onChange={(value) => updateField(field, value)}
              onFocus={onSelect}
              resourceCandidates={resourceCandidates}
              value={visualFieldValue(command, field, advService)}
            />
          ))
        ) : (
          <p className="visual-fields-empty">
            {schema
              ? "This command has no editable settings."
              : "Enable its command extension to edit this command visually."}
          </p>
        )}
      </div>
    </article>
  );
}
