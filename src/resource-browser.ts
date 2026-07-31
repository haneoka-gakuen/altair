/**
 * A provider-owned path. Hosts must treat segments as opaque labels and pass
 * them back to the provider without applying source-specific path rules.
 */
export type ResourceBrowserPath = readonly string[];

export type ResourceBrowserDisplayKind =
  | "image"
  | "audio"
  | "video"
  | "model"
  | "scene"
  | "data"
  | "other"
  | (string & {});

export interface ResourceBrowserRequest {
  /** Authoring insert kinds accepted by the active editor target. */
  readonly acceptedKinds: readonly string[];
  readonly preferredKind?: string;
  readonly signal?: AbortSignal;
  /** Opaque host context interpreted only by the selected provider. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ResourceBrowserDirectory {
  readonly type: "directory";
  readonly id: string;
  readonly name: string;
  readonly path: ResourceBrowserPath;
  readonly description?: string;
}

export interface ResourceBrowserFile<Reference = unknown> {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly path: ResourceBrowserPath;
  readonly description?: string;
  readonly detail?: string;
  readonly displayKind: ResourceBrowserDisplayKind;
  readonly previewUrl?: string;
  readonly audioPreviewUrl?: string;
  /** Insert kinds this file can produce when opened. */
  readonly acceptedKinds: readonly string[];
  readonly available: boolean;
  /** Provider-owned handle; hosts must not inspect or persist it. */
  readonly reference: Reference;
}

export type ResourceBrowserNode<Reference = unknown> =
  | ResourceBrowserDirectory
  | ResourceBrowserFile<Reference>;

export interface ResourceBrowserInsert<Value = unknown> {
  readonly kind: string;
  readonly key: string;
  readonly value: Value;
  readonly usage?: string;
  /** Provider-owned lossless metadata; hosts preserve and forward it. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * Source plugins own traversal, previews, availability and insert
 * normalization. Hosts only render nodes and forward user intent.
 */
export interface ResourceBrowserProvider<
  Reference = unknown,
  Value = unknown,
> {
  readonly id: string;
  readonly name: string;
  readonly roots: readonly ResourceBrowserDirectory[];
  preferredPath(request: ResourceBrowserRequest): ResourceBrowserPath;
  list(
    path: ResourceBrowserPath,
    request: ResourceBrowserRequest,
  ):
    | readonly ResourceBrowserNode<Reference>[]
    | Promise<readonly ResourceBrowserNode<Reference>[]>;
  open(
    file: ResourceBrowserFile<Reference>,
    request: ResourceBrowserRequest,
  ):
    | ResourceBrowserInsert<Value>
    | undefined
    | Promise<ResourceBrowserInsert<Value> | undefined>;
  refresh?(request: ResourceBrowserRequest): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
