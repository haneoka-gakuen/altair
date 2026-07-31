import {
  cloneStoryValue,
  type AltairCommandFieldSchema,
  type AltairCommandSchemaContribution,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
} from "@haneoka/altair";
import type { AltairAdvService } from "@haneoka/altair-plugin-adv";
import type { StudioProjectFile } from "./folder-workspace";

export interface VisualResourceCandidate {
  readonly kind: string;
  readonly label: string;
  readonly usage?: string;
  readonly value: string;
}

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const metadataString = (
  field: AltairCommandFieldSchema,
  key: string,
): string | undefined => {
  const value = field.metadata?.[key];
  return typeof value === "string" && value ? value : undefined;
};

const metadataInteger = (
  field: AltairCommandFieldSchema,
  key: string,
): number | undefined => {
  const value = field.metadata?.[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
};

const metadataBoolean = (
  field: AltairCommandFieldSchema,
  key: string,
): boolean | undefined => {
  const value = field.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
};

export const visualFieldNativeKind = (
  field: AltairCommandFieldSchema,
): string => metadataString(field, "nativeKind") ?? field.kind;

export const visualFieldPlaceholder = (
  field: AltairCommandFieldSchema,
): string | undefined => metadataString(field, "placeholder");

const advFieldDescriptor = (
  command: StoryProjectCommand,
  field: AltairCommandFieldSchema,
  service?: AltairAdvService,
) =>
  service
    ?.commandFieldDescriptors(command)
    .find(({ key }) => key === field.key);

/**
 * Filters present-only schema hints through the owning plugin service. A
 * source-only optional slot therefore does not appear as a made-up setting.
 */
export const visualFieldsFor = (
  command: StoryProjectCommand,
  schema: AltairCommandSchemaContribution | undefined,
  service?: AltairAdvService,
): readonly AltairCommandFieldSchema[] => {
  const fields = schema?.fields ?? [];
  if (service) {
    const descriptors = service.commandFieldDescriptors(command);
    if (!descriptors.length && !schema?.id.startsWith("adv.command.")) {
      return fields;
    }
    const byKey = new Map(fields.map((field) => [field.key, field]));
    return descriptors.map((descriptor) => {
      const contributed = byKey.get(descriptor.key);
      if (contributed) return contributed;
      const nativeKind = descriptor.kind;
      const kind: AltairCommandFieldSchema["kind"] =
        nativeKind === "text"
          ? "string"
          : [
                "localized-list",
                "vector3",
                "multi-select",
                "choice-list",
                "resource-list",
              ].includes(nativeKind)
            ? "json"
            : nativeKind;
      return {
        key: descriptor.key,
        label: descriptor.label,
        kind,
        ...(descriptor.required === undefined
          ? {}
          : { required: descriptor.required }),
        ...(descriptor.resource === undefined
          ? {}
          : { resourceKind: descriptor.resource }),
        ...(descriptor.choices === undefined
          ? {}
          : { options: descriptor.choices }),
        metadata: {
          nativeKind,
          ...(descriptor.sourceKey === undefined
            ? {}
            : { sourceKey: descriptor.sourceKey }),
          ...(descriptor.parameterIndex === undefined
            ? {}
            : { parameterIndex: descriptor.parameterIndex }),
          ...(descriptor.parameterEncoding === undefined
            ? {}
            : { parameterEncoding: descriptor.parameterEncoding }),
          ...(descriptor.presentOnly === undefined
            ? {}
            : { presentOnly: descriptor.presentOnly }),
          ...(descriptor.placeholder === undefined
            ? {}
            : { placeholder: descriptor.placeholder }),
        },
      };
    });
  }
  return fields.filter((field) => {
    if (metadataBoolean(field, "presentOnly") !== true) return true;
    const sourceKey = metadataString(field, "sourceKey") ?? field.key;
    return Object.hasOwn(command.fields, sourceKey);
  });
};

/**
 * Reads one canonical field. ADV schemas use their service so parameter slots
 * and other codec-private details never leak into Studio. Third-party schemas
 * fall back to the declarative sourceKey/parameterIndex metadata contract.
 */
export const visualFieldValue = (
  command: StoryProjectCommand,
  field: AltairCommandFieldSchema,
  service?: AltairAdvService,
): JsonValue | undefined => {
  const descriptor = advFieldDescriptor(command, field, service);
  if (descriptor && service) {
    return service.storyCommandFieldValue(command, descriptor);
  }
  const sourceKey = metadataString(field, "sourceKey") ?? field.key;
  const parameterIndex = metadataInteger(field, "parameterIndex");
  if (parameterIndex === undefined) return command.fields[sourceKey];
  const parameters = command.fields[sourceKey];
  return Array.isArray(parameters) ? parameters[parameterIndex] : undefined;
};

/**
 * Replaces one semantic field without mutating the command. Plugin-private
 * parameter encodings are preserved through the ADV service when available.
 */
export const replaceVisualFieldValue = (
  command: StoryProjectCommand,
  field: AltairCommandFieldSchema,
  value: JsonValue | undefined,
  service?: AltairAdvService,
): StoryProjectCommand => {
  const descriptor = advFieldDescriptor(command, field, service);
  if (descriptor && service) {
    return {
      ...command,
      fields: service.replaceStoryCommandFieldValue(
        command.fields,
        descriptor,
        value,
      ),
    };
  }

  const fields = cloneStoryValue(command.fields);
  const sourceKey = metadataString(field, "sourceKey") ?? field.key;
  const parameterIndex = metadataInteger(field, "parameterIndex");
  if (parameterIndex === undefined) {
    if (value === undefined) delete fields[sourceKey];
    else fields[sourceKey] = cloneStoryValue(value);
  } else {
    const parameters = Array.isArray(fields[sourceKey])
      ? [...fields[sourceKey]]
      : [];
    while (parameters.length <= parameterIndex) parameters.push("");
    const encoded =
      metadataString(field, "parameterEncoding") === "string" &&
      (typeof value === "number" || typeof value === "boolean")
        ? String(value)
        : value;
    parameters[parameterIndex] =
      encoded === undefined ? "" : cloneStoryValue(encoded);
    while (parameters.at(-1) === "") parameters.pop();
    if (parameters.length) fields[sourceKey] = parameters;
    else delete fields[sourceKey];
  }
  return { ...command, fields };
};

const LOCALE_INDEX = Object.freeze(
  new Map<string, number>([
    ["ja", 0],
    ["ja-jp", 0],
    ["en", 1],
    ["en-us", 1],
    ["en-gb", 1],
    ["zh-tw", 2],
    ["zh-hant", 2],
    ["zh-cn", 3],
    ["zh-hans", 3],
    ["ko", 4],
    ["ko-kr", 4],
  ]),
);

export const VISUAL_LOCALES = Object.freeze([
  { key: "ja", label: "Japanese" },
  { key: "en", label: "English" },
  { key: "zh-TW", label: "Traditional Chinese" },
  { key: "zh-CN", label: "Simplified Chinese" },
  { key: "ko", label: "Korean" },
] as const);

export interface VisualLocaleOption {
  readonly key: string;
  readonly label: string;
  readonly fonts?: readonly string[];
}

/** Slot used only when the ADV plugin supplies an existing fixed-slot value. */
export const visualLocaleSlot = (locale?: string): number | undefined =>
  LOCALE_INDEX.get(locale?.trim().toLowerCase() ?? "");

const legacyLocalizedRecord = (
  value: JsonValue | undefined,
  scalarLocale: string,
): JsonObject => {
  if (object(value)) return { ...object(value) };
  if (Array.isArray(value)) {
    return Object.fromEntries(
      VISUAL_LOCALES.flatMap(({ key }, index) => {
        const candidate = value[index];
        return typeof candidate === "string" && candidate
          ? [[key, candidate] as const]
          : [];
      }),
    );
  }
  return typeof value === "string" && value
    ? { [scalarLocale]: value }
    : {};
};

export const visualLocalizedValueForLocale = (
  value: JsonValue | undefined,
  locale: string,
): string => {
  const record = object(value);
  if (record) {
    const direct = record[locale];
    if (typeof direct === "string") return direct;
    const normalized = locale.trim().toLowerCase();
    const matching = Object.entries(record).find(
      ([key, candidate]) =>
        key.toLowerCase() === normalized && typeof candidate === "string",
    )?.[1];
    return typeof matching === "string" ? matching : "";
  }
  if (Array.isArray(value)) {
    const slot = visualLocaleSlot(locale);
    const candidate = slot === undefined ? undefined : value[slot];
    return typeof candidate === "string" ? candidate : "";
  }
  return typeof value === "string" ? value : "";
};

export const replaceVisualLocalizedValueForLocale = (
  value: JsonValue | undefined,
  locale: string,
  text: string,
): JsonValue => {
  const record = object(value);
  if (record) return { ...record, [locale]: text };
  const slot = visualLocaleSlot(locale);
  if (slot !== undefined) {
    if (typeof value === "string" && slot === 0) return text;
    const next = Array.isArray(value)
      ? [...value]
      : [typeof value === "string" ? value : ""];
    while (next.length < VISUAL_LOCALES.length) next.push("");
    next[slot] = text;
    return next;
  }
  return {
    ...legacyLocalizedRecord(value, locale),
    [locale]: text,
  };
};

export const visualLocalizedListValue = (
  value: JsonValue | undefined,
  localeIndex: number,
): string => {
  if (Array.isArray(value)) {
    const candidate = value[localeIndex];
    return typeof candidate === "string" ? candidate : "";
  }
  const record = object(value);
  if (record) {
    const candidate = record[VISUAL_LOCALES[localeIndex]?.key ?? String(localeIndex)];
    return typeof candidate === "string" ? candidate : "";
  }
  return localeIndex === 0 && typeof value === "string" ? value : "";
};

export const replaceVisualLocalizedListValue = (
  command: StoryProjectCommand,
  field: AltairCommandFieldSchema,
  localeIndex: number,
  text: string,
  service?: AltairAdvService,
): StoryProjectCommand => {
  const previous = visualFieldValue(command, field, service);
  let next: JsonValue;
  if (object(previous)) {
    next = {
      ...object(previous),
      [VISUAL_LOCALES[localeIndex]?.key ?? String(localeIndex)]: text,
    };
  } else {
    const values = Array.isArray(previous)
      ? [...previous]
      : [typeof previous === "string" ? previous : ""];
    while (values.length < VISUAL_LOCALES.length) values.push("");
    values[localeIndex] = text;
    next = values;
  }
  return replaceVisualFieldValue(command, field, next, service);
};

export interface VisualVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const finiteNumber = (value: JsonValue | undefined): number => {
  const result =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(result) ? result : 0;
};

export const visualVector3 = (
  value: JsonValue | undefined,
): VisualVector3 => {
  if (Array.isArray(value)) {
    return {
      x: finiteNumber(value[0]),
      y: finiteNumber(value[1]),
      z: finiteNumber(value[2]),
    };
  }
  const record = object(value);
  return {
    x: finiteNumber(record?.x),
    y: finiteNumber(record?.y),
    z: finiteNumber(record?.z),
  };
};

export const replaceVisualVector3Axis = (
  value: JsonValue | undefined,
  axis: keyof VisualVector3,
  coordinate: number,
): JsonValue => {
  if (Array.isArray(value)) {
    const next = [...value];
    const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    while (next.length < 3) next.push(0);
    next[index] = coordinate;
    return next;
  }
  return { ...(object(value) ?? {}), [axis]: coordinate };
};

export const commandSchemaFor = (
  command: StoryProjectCommand,
  schemas: readonly AltairCommandSchemaContribution[],
): AltairCommandSchemaContribution | undefined =>
  schemas.find(
    ({ opcodes }) =>
      command.command !== null && opcodes?.includes(command.command),
  ) ??
  schemas.find(({ sourceNames }) =>
    sourceNames?.some(
      (name) =>
        name.toLowerCase() === command.source?.command?.toLowerCase(),
    ),
  );

export const authorableCommandSchemas = (
  schemas: readonly AltairCommandSchemaContribution[],
): readonly AltairCommandSchemaContribution[] => {
  const seen = new Set<string>();
  return schemas.filter((schema) => {
    if (!schema.create || seen.has(schema.id)) return false;
    seen.add(schema.id);
    return true;
  });
};

export const filterCommandSchemas = (
  schemas: readonly AltairCommandSchemaContribution[],
  query: string,
  category = "",
): readonly AltairCommandSchemaContribution[] => {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCategory = category.trim().toLowerCase();
  return authorableCommandSchemas(schemas).filter((schema) => {
    if (
      normalizedCategory &&
      (schema.category ?? "other").toLowerCase() !== normalizedCategory
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [
      schema.name,
      schema.id,
      schema.category,
      ...(schema.sourceNames ?? []),
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  });
};

export const commandSchemaCategories = (
  schemas: readonly AltairCommandSchemaContribution[],
): readonly string[] =>
  [
    ...new Set(
      authorableCommandSchemas(schemas).map(
        ({ category }) => category?.trim() || "other",
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

const resourceKinds = (file: StudioProjectFile): readonly string[] => {
  const kinds = new Set<string>([file.resourceKind, file.kind]);
  if (file.resourceKind === "figure" || file.kind === "image") {
    for (const kind of ["still", "frame", "effect", "post-effect"]) {
      kinds.add(kind);
    }
  }
  if (file.kind === "model") kinds.add("live2d");
  if (file.resourceKind === "data") kinds.add("timeline");
  return [...kinds];
};

export const visualResourceCandidates = (
  files: readonly StudioProjectFile[],
  sourceReferences: readonly string[] = [],
): readonly VisualResourceCandidate[] => {
  const seen = new Set<string>();
  const appendFileCandidates = (
    file: StudioProjectFile,
    value: string,
  ): readonly VisualResourceCandidate[] =>
    resourceKinds(file).flatMap((kind) => {
      const usage = "usage" in file ? file.usage : undefined;
      const key = `${kind}\u0000${usage ?? ""}\u0000${value}`;
      if (!value || seen.has(key)) return [];
      seen.add(key);
      return [{
        kind,
        label: file.displayPath || file.name,
        ...(usage ? { usage } : {}),
        value,
      }];
    });
  const typed = files.flatMap((file) => {
    if (file.kind === "scene" || file.kind === "other") return [];
    const value =
      file.resourceKey ||
      file.logicalPath.replace(/^game\//iu, "") ||
      file.path;
    return appendFileCandidates(file, value);
  });
  const normalizeReference = (value: string): string =>
    value.trim().replaceAll("\\", "/").replace(/^(?:\.\/|game\/)+/iu, "");
  const filesByAlias = new Map<string, StudioProjectFile>();
  for (const file of files) {
    for (const alias of [
      file.resourceKey,
      file.logicalPath,
      file.logicalPath.replace(/^game\//iu, ""),
      file.path,
      file.displayPath,
      file.name,
    ]) {
      const normalized = normalizeReference(alias);
      if (normalized && !filesByAlias.has(normalized)) {
        filesByAlias.set(normalized, file);
      }
    }
  }
  const aliases = sourceReferences.flatMap((value) => {
    const reference = value.trim();
    if (!reference) return [];
    const file = filesByAlias.get(normalizeReference(reference));
    return file ? appendFileCandidates(file, reference) : [];
  });
  return [...typed, ...aliases];
};

const sceneFor = (project: StoryProject, sceneId: string) => {
  const scene = project.scenes.find(({ id }) => id === sceneId);
  if (!scene) throw new ReferenceError(`Unknown Altair scene '${sceneId}'`);
  return scene;
};

export const replaceProjectCommand = (
  project: StoryProject,
  sceneId: string,
  commandId: string,
  nextCommand: StoryProjectCommand,
): StoryProject => {
  const next = cloneStoryValue(project);
  const scene = sceneFor(next, sceneId);
  const index = scene.commands.findIndex(({ id }) => id === commandId);
  if (index < 0) {
    throw new ReferenceError(`Unknown Altair command '${commandId}'`);
  }
  scene.commands[index] = cloneStoryValue(nextCommand);
  return next;
};

export const insertProjectCommand = (
  project: StoryProject,
  sceneId: string,
  index: number,
  command: StoryProjectCommand,
): StoryProject => {
  const next = cloneStoryValue(project);
  const scene = sceneFor(next, sceneId);
  const target = Math.max(0, Math.min(scene.commands.length, Math.round(index)));
  scene.commands.splice(target, 0, cloneStoryValue(command));
  return next;
};

export const removeProjectCommand = (
  project: StoryProject,
  sceneId: string,
  commandId: string,
): StoryProject => {
  const next = cloneStoryValue(project);
  const scene = sceneFor(next, sceneId);
  const index = scene.commands.findIndex(({ id }) => id === commandId);
  if (index >= 0) scene.commands.splice(index, 1);
  return next;
};

export const moveProjectCommand = (
  project: StoryProject,
  sceneId: string,
  fromIndex: number,
  toIndex: number,
): StoryProject => {
  const next = cloneStoryValue(project);
  const scene = sceneFor(next, sceneId);
  const from = Math.max(
    0,
    Math.min(scene.commands.length - 1, Math.round(fromIndex)),
  );
  const to = Math.max(
    0,
    Math.min(scene.commands.length - 1, Math.round(toIndex)),
  );
  if (from === to) return next;
  const [command] = scene.commands.splice(from, 1);
  if (command) scene.commands.splice(to, 0, command);
  return next;
};
