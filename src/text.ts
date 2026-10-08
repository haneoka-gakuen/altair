import { Document, LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { JsonValue } from "./model.js";

const options = {
  version: "1.2" as const,
  schema: "core",
  resolveKnownTags: false,
  stringKeys: true,
  uniqueKeys: true,
  strict: true,
};
const style = { indent: 2, lineWidth: 0, blockQuote: "literal" as const };

function document(source: string, lineCounter?: LineCounter) {
  const doc: Document = parseDocument(source, { ...options, ...(lineCounter ? { lineCounter } : {}) });
  const issue = doc.errors[0] ?? doc.warnings[0];
  if (issue) throw issue;
  if (doc.directives?.yaml.version !== "1.2") throw new TypeError("Use YAML 1.2 for authored documents");
  return doc;
}
function validate(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 128) throw new RangeError("Document nesting exceeds 128 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") throw new TypeError("Unsupported document value");
  if (seen.has(value)) throw new TypeError("Document aliases must not form a cycle");
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => validate(item, seen, depth + 1));
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Document values must be text, finite numbers, booleans, lists or mappings");
    for (const item of Object.values(value)) if (item !== undefined) validate(item, seen, depth + 1);
  }
  seen.delete(value);
}
export function parseAuthoredText(source: string): JsonValue {
  const value: unknown = document(source).toJS({ maxAliasCount: 100 });
  validate(value);
  return value as JsonValue;
}
const recordId = (value: unknown): string | undefined =>
  value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : undefined;

/** Reconcile the syntax tree so comments, scalar styles and node identities survive visual edits. */
export function serializeAuthoredText(value: unknown, source?: string): string {
  validate(value);
  if (source === undefined) return new Document(value, { ...options, aliasDuplicateObjects: false }).toString(style);
  const doc = document(source);
  const previous = doc.toJS({ maxAliasCount: 100 });
  validate(previous);
  const same = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right))
      return left.length === right.length && left.every((item, index) => same(item, right[index]));
    if (left && right && typeof left === "object" && typeof right === "object") {
      const a = Object.entries(left).filter(([, value]) => value !== undefined);
      const b = Object.entries(right).filter(([, value]) => value !== undefined);
      return (
        a.length === b.length &&
        a.every(([key, value]) => Object.hasOwn(right, key) && same(value, (right as Record<string, unknown>)[key]))
      );
    }
    return false;
  };
  if (same(previous, value)) return source;
  const create = (value: unknown, previous?: Node | null): Node => {
    const node = doc.createNode(value, { aliasDuplicateObjects: false });
    if (previous) {
      if (previous.comment !== undefined) node.comment = previous.comment;
      if (previous.commentBefore !== undefined) node.commentBefore = previous.commentBefore;
      if (previous.spaceBefore !== undefined) node.spaceBefore = previous.spaceBefore;
    }
    return node;
  };
  const merge = (node: Node | null, value: unknown, previousValue?: unknown): Node => {
    if (isAlias(node)) return create(value, node);
    if (isMap(node) && value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value).filter(([, value]) => value !== undefined);
      const keys = new Set(entries.map(([key]) => key));
      node.items = node.items.filter((pair) => isScalar(pair.key) && keys.has(String(pair.key.value)));
      for (const [key, item] of entries) {
        const pair = node.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
        if (pair)
          pair.value = merge(
            pair.value as Node | null,
            item,
            previousValue && typeof previousValue === "object"
              ? (previousValue as Record<string, unknown>)[key]
              : undefined,
          );
        else node.add(doc.createPair(key, item, { aliasDuplicateObjects: false }));
      }
      return node;
    }
    if (isSeq(node) && Array.isArray(value)) {
      const old = [...node.items];
      const oldValues = Array.isArray(previousValue) ? previousValue : [];
      const byId = new Map<string, number[]>();
      const newCounts = new Map<string, number>();
      old.forEach((item, index) => {
        const id = isMap(item) ? item.get("id") : undefined;
        if (typeof id === "string") {
          const indices = byId.get(id) ?? [];
          indices.push(index);
          byId.set(id, indices);
        }
      });
      for (const item of value) {
        const id = recordId(item);
        if (id !== undefined) newCounts.set(id, (newCounts.get(id) ?? 0) + 1);
      }
      const matches = new Map<number, number>();
      const used = new Set<unknown>();
      const reserve = (index: number, oldIndex: number) => {
        matches.set(index, oldIndex);
        used.add(old[oldIndex]);
      };
      // Plan all matches before mutating nodes: unique IDs, then unchanged
      // duplicate payloads, then remaining occurrences of the same ID.
      value.forEach((item, index) => {
        const id = recordId(item);
        const indices = id === undefined ? undefined : byId.get(id);
        if (indices?.length === 1 && newCounts.get(id!) === 1) reserve(index, indices[0]!);
      });
      for (const exact of [true, false]) {
        value.forEach((item, index) => {
          if (matches.has(index)) return;
          const id = recordId(item);
          const indices = id === undefined ? undefined : byId.get(id);
          const oldIndex = indices?.find(
            (candidate) => !used.has(old[candidate]) && (!exact || same(oldValues[candidate], item)),
          );
          if (oldIndex !== undefined) reserve(index, oldIndex);
        });
      }
      value.forEach((_, index) => {
        if (!matches.has(index) && index < old.length && !used.has(old[index])) reserve(index, index);
      });
      node.items = value.map((item, index) => {
        const oldIndex = matches.get(index);
        return merge(
          oldIndex === undefined ? null : (old[oldIndex] as Node | null),
          item,
          oldIndex === undefined ? undefined : oldValues[oldIndex],
        );
      });
      return node;
    }
    if (isScalar(node) && (value === null || typeof value !== "object")) {
      if (typeof node.value !== typeof value) return create(value, node);
      node.value = value;
      if (typeof value === "string" && value.includes("\n") && (!node.type || node.type === "PLAIN"))
        node.type = "BLOCK_LITERAL";
      return node;
    }
    return create(value, node);
  };
  doc.contents = merge(doc.contents, value, previous);
  const output = doc.toString(style);
  if (!same(parseAuthoredText(output), value)) throw new Error("Document serialization changed a value");
  return output;
}
export function authoredNodeLines(source: string, collection = "nodes"): ReadonlyMap<string, number> {
  const lines = new LineCounter(),
    doc = document(source, lines),
    result = new Map<string, number>();
  const visit = (node: unknown) => {
    if (!isMap(node)) return;
    const id = node.get("id");
    if (typeof id === "string" && node.range) result.set(id, lines.linePos(node.range[0]).line);
    const children = node.get("children", true);
    if (isSeq(children)) children.items.forEach(visit);
  };
  const nodes = doc.get(collection, true);
  if (isSeq(nodes)) nodes.items.forEach(visit);
  return result;
}

export function formatAuthoredText(source: string): string {
  parseAuthoredText(source);
  return document(source).toString(style);
}
