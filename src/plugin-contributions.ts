/// <reference lib="dom" />

import type { AltairAiProvider } from "./ai-protocol.js";
import type { StoryDiagnostic } from "./diagnostics.js";
import type {
  JsonObject,
  JsonValue,
  StoryProject,
  StoryProjectCommand,
} from "./model.js";
import type { ResourceBrowserProvider } from "./resource-browser.js";

export type {
  AltairAdaptationRequest,
  AltairAdaptationResult,
  AltairAiProvenance,
  AltairAiProvider,
} from "./ai-protocol.js";

export type AltairDisposable =
  | { dispose(): void | Promise<void> }
  | { destroy(): void | Promise<void> }
  | { close(): void | Promise<void> }
  | (() => void | Promise<void>);

export interface AltairServiceKey<T> {
  readonly id: string;
  readonly __type?: T;
}

export const defineAltairService = <T>(
  id: string,
): AltairServiceKey<T> => {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("Altair service id must not be empty");
  }
  return Object.freeze({ id: id.trim() });
};

export interface AltairContribution {
  readonly id: string;
  readonly name?: string;
}

export interface AltairContributionOptions {
  /** Higher values win within an override or singleton selection group. */
  readonly priority?: number;
  /** Contribution id or `plugin-id:contribution-id` to replace. */
  readonly override?: string | readonly string[];
  /** At most one contribution remains active on a named port. */
  readonly singletonPort?: string;
}

export interface AltairContributionSelection<
  T extends AltairContribution = AltairContribution,
> {
  readonly owner: string;
  readonly kind: keyof AltairContributionMap;
  readonly contribution: T;
  readonly priority: number;
  readonly overrides: readonly string[];
  readonly singletonPort?: string;
  readonly active: boolean;
  readonly suppressedBy?: string;
}

export interface AltairOperationContext {
  readonly signal: AbortSignal;
  service<T>(key: AltairServiceKey<T>): T | undefined;
}

export interface AltairSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface AltairFormatRequest {
  readonly files: readonly AltairSourceFile[];
  readonly entryPath?: string;
  readonly options?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface AltairFormatSniffResult {
  readonly id: string;
  readonly owner: string;
  readonly score: number;
  readonly priority: number;
}

export interface AltairFormatImportResult {
  readonly format: string;
  readonly project: StoryProject;
  readonly diagnostics: readonly StoryDiagnostic[];
}

export interface AltairFormatArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface AltairFormatExportRequest {
  readonly project: StoryProject;
  readonly entryPath?: string;
  readonly options?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface AltairFormatExportResult {
  readonly artifacts: readonly AltairFormatArtifact[];
  readonly diagnostics: readonly StoryDiagnostic[];
}

/**
 * Multi-file, cancellable format boundary. Implementations return diagnostics
 * instead of discarding source-fidelity information.
 */
export interface AltairFormatContribution extends AltairContribution {
  readonly extensions: readonly string[];
  readonly mediaTypes?: readonly string[];
  sniff(
    request: AltairFormatRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): number | Promise<number>;
  import(
    request: AltairFormatRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): AltairFormatImportResult | Promise<AltairFormatImportResult>;
  export(
    request: AltairFormatExportRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): AltairFormatExportResult | Promise<AltairFormatExportResult>;
}

export type AltairCommandFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "resource"
  | "localized-text"
  | "json"
  | (string & {});

export interface AltairCommandFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly kind: AltairCommandFieldKind;
  readonly required?: boolean;
  readonly resourceKind?: string;
  readonly options?: readonly {
    readonly label: string;
    readonly value: JsonValue;
  }[];
  /** Format-specific editor hints which remain JSON-serializable. */
  readonly metadata?: JsonObject;
}

/** Declarative command metadata shared by source and visual editors. */
export interface AltairCommandSchemaContribution extends AltairContribution {
  readonly category?: string;
  readonly opcodes?: readonly number[];
  readonly sourceNames?: readonly string[];
  readonly fields?: readonly AltairCommandFieldSchema[];
  readonly metadata?: JsonObject;
  create?(
    project: StoryProject,
    context: AltairOperationContext,
  ): StoryProjectCommand | Promise<StoryProjectCommand>;
}

export interface AltairEditorActionRequest {
  readonly project: StoryProject;
  readonly sceneId?: string;
  readonly commandId?: string;
  readonly payload?: JsonValue;
  readonly signal?: AbortSignal;
}

export interface AltairEditorActionContribution extends AltairContribution {
  readonly label: string;
  readonly location?: string;
  run(
    request: AltairEditorActionRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): StoryProject | Promise<StoryProject>;
}

export interface AltairCompilerPassRequest {
  readonly project: StoryProject;
  readonly sceneId: string;
  readonly commandIndex: number;
  readonly command: StoryProjectCommand;
  readonly output?: JsonObject | null;
  readonly signal?: AbortSignal;
}

export interface AltairCompilerPassResult {
  readonly command?: StoryProjectCommand;
  readonly output?: JsonObject | null;
  readonly diagnostics?: readonly StoryDiagnostic[];
}

export interface AltairCompilerPipelineResult {
  readonly command: StoryProjectCommand;
  readonly output?: JsonObject | null;
  readonly diagnostics: readonly StoryDiagnostic[];
}

export interface AltairCompilerPassContribution
  extends AltairContribution {
  /** Lower values execute first. Selection priority is independent. */
  readonly order?: number;
  apply(
    request: AltairCompilerPassRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ):
    | AltairCompilerPassResult
    | void
    | Promise<AltairCompilerPassResult | void>;
}

export interface AltairValidatorContribution extends AltairContribution {
  validate(
    project: StoryProject,
    context: AltairOperationContext,
  ): readonly StoryDiagnostic[] | Promise<readonly StoryDiagnostic[]>;
}

/**
 * Minimal flow projection shared by hosts and flow plugins.
 *
 * Concrete node, edge, and diagnostic schemas belong to the selected flow
 * plugin. The host only requires a cloneable graph envelope.
 */
export interface AltairFlowGraph {
  readonly entryNodeId: string;
  readonly exitNodeId: string;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly diagnostics: readonly unknown[];
}

export interface AltairFlowProviderContribution
  extends AltairContribution {
  build(
    project: StoryProject,
    context: AltairOperationContext,
  ): AltairFlowGraph | Promise<AltairFlowGraph>;
}

export interface AltairAssetRequest {
  readonly project: StoryProject;
  readonly reference: string;
  readonly kind?: string;
  readonly signal?: AbortSignal;
}

export interface AltairResolvedAsset {
  readonly id: string;
  readonly source?: string;
  readonly bytes?: Uint8Array;
  readonly mediaType?: string;
  readonly metadata?: JsonObject;
}

export interface AltairAssetProviderContribution
  extends AltairContribution {
  supports?(
    request: AltairAssetRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): boolean | number | Promise<boolean | number>;
  resolve(
    request: AltairAssetRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ):
    | AltairResolvedAsset
    | undefined
    | Promise<AltairResolvedAsset | undefined>;
}

export interface AltairPanelContext extends AltairOperationContext {
  readonly project?: StoryProject;
  readonly selection?: JsonObject;
}

/** DOM mounting is isolated to the optional panel contribution boundary. */
export interface AltairPanelContribution extends AltairContribution {
  readonly slot: string;
  mount(
    host: HTMLElement,
    context: AltairPanelContext,
  ): AltairDisposable | Promise<AltairDisposable>;
}

export interface AltairPreviewRequest {
  readonly project?: StoryProject;
  readonly identity?: JsonObject;
  readonly options?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface AltairPreviewSession {
  readonly capabilities?: readonly string[];
  request(
    command: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonValue>;
  onEvent?(listener: (event: JsonValue) => void): () => void;
  dispose(): void | Promise<void>;
}

export interface AltairPreviewProviderContribution
  extends AltairContribution {
  create(
    request: AltairPreviewRequest & { readonly signal: AbortSignal },
    context: AltairOperationContext,
  ): AltairPreviewSession | Promise<AltairPreviewSession>;
}

export interface AltairContributionMap {
  readonly format: AltairFormatContribution;
  readonly ai: AltairAiProvider;
  readonly validator: AltairValidatorContribution;
  readonly command: AltairCommandSchemaContribution;
  readonly "editor-action": AltairEditorActionContribution;
  readonly compiler: AltairCompilerPassContribution;
  readonly flow: AltairFlowProviderContribution;
  readonly asset: AltairAssetProviderContribution;
  readonly "resource-browser": ResourceBrowserProvider;
  readonly panel: AltairPanelContribution;
  readonly preview: AltairPreviewProviderContribution;
}
