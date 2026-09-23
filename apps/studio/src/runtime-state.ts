import type { JsonValue } from "@haneoka/altair";

export interface RuntimeVariable {
  readonly path: string;
  readonly name: string;
  readonly scope: string;
  readonly value: JsonValue;
}

const record = (value: unknown): value is Record<string, JsonValue> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const variableContainer = /^(?:gamevar|variables?|vars|globals?|locals?|globalvariables|localvariables)$/i;

const scopeName = (path: readonly string[]): string => {
  const namedScope = [...path].reverse().find((part) => /global|local|session|scene|game/i.test(part));
  return namedScope?.replace(/variables?|vars?/i, "").replace(/[-_.]+$/g, "") || "runtime";
};

/**
 * Find variable stores in an opaque Vega snapshot without assuming one engine
 * implementation. Containers keep their full JSON path so similarly named
 * local/global values never overwrite each other in the inspector.
 */
export const extractRuntimeVariables = (snapshot: JsonValue | undefined | null): readonly RuntimeVariable[] => {
  if (!record(snapshot)) return [];
  const variables: RuntimeVariable[] = [];
  const seenPaths = new Set<string>();
  const walk = (value: JsonValue, path: readonly string[], depth: number): void => {
    if (depth > 10 || !record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (variableContainer.test(key) && record(child)) {
        for (const [name, variableValue] of Object.entries(child)) {
          const fullPath = [...childPath, name].join(".");
          if (seenPaths.has(fullPath)) continue;
          seenPaths.add(fullPath);
          variables.push({
            path: fullPath,
            name,
            scope: scopeName(childPath),
            value: variableValue,
          });
        }
      }
      if (record(child)) walk(child, childPath, depth + 1);
    }
  };
  walk(snapshot, [], 0);
  return variables.sort((left, right) =>
    left.scope === right.scope ? left.name.localeCompare(right.name) : left.scope.localeCompare(right.scope),
  );
};

export const runtimeScalarSummary = (
  snapshot: JsonValue | undefined | null,
): ReadonlyArray<{ readonly key: string; readonly value: string }> => {
  if (!record(snapshot)) return [];
  const preferred = [
    "ready",
    "loading",
    "playing",
    "paused",
    "finished",
    "commandIndex",
    "commandCount",
    "currentSceneId",
    "error",
  ];
  return preferred.flatMap((key) => {
    const value = snapshot[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [{ key, value: String(value) }]
      : [];
  });
};

export const formatRuntimeValue = (value: JsonValue): string => {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};
