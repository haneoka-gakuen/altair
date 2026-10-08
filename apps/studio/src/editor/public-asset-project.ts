import { parseAltairProjectDocument, serializeAltairDocument, type JsonObject } from "@haneoka/altair";
import type { EditorPublicAsset } from "./resource-manifest";
import type { LocalPublicAssetPlan } from "./public-asset-import";

const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid asset collection");
  return value as JsonObject;
};
const categories: Record<string, string> = {
  model: "live2d",
  spine: "live2d",
  background: "backgrounds",
  still: "stills",
  stamp: "stills",
  frame: "frames",
  audio: "sounds",
  video: "videos",
  effect: "effects",
};
/** Reject duplicate registrations and malformed collections before downloading members. */
export function assertLocalPublicAssetAvailable(source: string, asset: EditorPublicAsset): void {
  const project = parseAltairProjectDocument(source);
  const category = categories[asset.kind];
  if (asset.kind !== "post-effect" && !category) throw new TypeError("Unsupported local public asset kind");
  const collection = asset.kind === "post-effect" ? project.runtime.postEffects : project.assets[category!];
  if (collection !== undefined && Object.hasOwn(object(collection), asset.id))
    throw new Error("This public asset is already imported");
  const ledger = project.extensions?.publicAssetImports;
  if (ledger !== undefined && !Array.isArray(ledger)) throw new TypeError("Invalid public import ledger");
  if (ledger?.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === asset.id))
    throw new Error("This public asset is already imported");
}
/** Register local loader paths and source provenance in the existing project document. */
export function registerLocalPublicAsset(source: string, asset: EditorPublicAsset, plan: LocalPublicAssetPlan): string {
  if (plan.sourceAssetId !== asset.id || plan.schema !== "altair-local-public-asset-v1")
    throw new TypeError("Asset plan identity mismatch");
  assertLocalPublicAssetAvailable(source, asset);
  const project = parseAltairProjectDocument(source),
    assets = structuredClone(project.assets),
    runtime = structuredClone(project.runtime);
  const value = { ...structuredClone(plan.value), resourceRef: asset.id };
  if (asset.kind === "post-effect") {
    runtime.postEffects = { ...object(runtime.postEffects ?? {}), [asset.id]: value };
  } else {
    const category = categories[asset.kind]!;
    assets[category] = { ...object(assets[category] ?? {}), [asset.id]: value };
  }
  const ledger = project.extensions?.publicAssetImports as JsonObject[] | undefined;
  return serializeAltairDocument(
    {
      ...project,
      assets,
      runtime,
      extensions: { ...project.extensions, publicAssetImports: [...(ledger ?? []), structuredClone(plan.metadata)] },
    },
    source,
  );
}
