import type { JsonObject, AltairAuthoredNode } from "@haneoka/altair";
import { WEBGAL_COMMAND_TYPES } from "@haneoka/vega-plugin-webgal/commands";
import type { StudioPreviewBridge } from "../preview-bridge";
import type { EditorSession, EditorDocument } from "./session";

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export const transformFields = [
  { key: "x", label: "Position X (px)", fallback: 0, step: 1 },
  { key: "y", label: "Position Y (px)", fallback: 0, step: 1 },
  { key: "scaleX", label: "Scale X", fallback: 1, step: 0.01 },
  { key: "scaleY", label: "Scale Y", fallback: 1, step: 0.01 },
  { key: "rotation", label: "Rotation (degrees)", fallback: 0, step: 1 },
  { key: "alpha", label: "Opacity", fallback: 1, step: 0.01 },
] as const;
export type TransformField = typeof transformFields[number]["key"];
export type TransformDraft = Partial<Record<TransformField, number>>;

export function transformKind(node: AltairAuthoredNode | undefined): "stage" | "target" | undefined {
  if (node?.type.plugin !== "haneoka.altair-webgal") return undefined;
  if (node.type.name === "effect.stageTransform") return "stage";
  if (node.type.name === "effect.setTransform") return "target";
  return undefined;
}

export function authoredTransformValue(node: AltairAuthoredNode, key: TransformField): number | undefined {
  const kind = transformKind(node), transform = object(node.arguments.transform);
  const raw = kind === "stage"
    ? node.arguments[key === "scaleX" || key === "scaleY" ? "scale" : key]
    : key === "x" || key === "y" ? object(transform.position)[key]
      : key === "scaleX" || key === "scaleY" ? object(transform.scale)[key === "scaleX" ? "x" : "y"]
        : transform[key];
  if (typeof raw !== "number") return undefined;
  return key === "rotation" && kind === "target" ? raw * 180 / Math.PI : raw;
}

export function transformValue(node: AltairAuthoredNode, key: TransformField): number {
  return authoredTransformValue(node, key) ?? transformFields.find(field => field.key === key)!.fallback;
}

export function transformArguments(node: AltairAuthoredNode, draft: TransformDraft): JsonObject {
  const kind = transformKind(node);
  if (!kind) throw new Error("Select a WebGAL transform statement");
  const arguments_ = { ...node.arguments }, transform = { ...object(arguments_.transform) };
  for (const [field, value] of Object.entries(draft)) {
    if (!transformFields.some(candidate => candidate.key === field)) throw new RangeError("Unsupported transform field");
    if (!Number.isFinite(value)) throw new RangeError("Transform values must be finite");
    if (field === "alpha" && (value! < 0 || value! > 1)) throw new RangeError("Opacity must be between zero and one");
    if (kind === "stage") {
      if (field === "alpha" || field === "scaleY") throw new RangeError("Unsupported stage transform field");
      arguments_[field === "scaleX" ? "scale" : field] = value!;
    } else if (field === "x" || field === "y") {
      transform.position = { ...object(transform.position), [field]: value! };
    } else if (field === "scaleX" || field === "scaleY") {
      transform.scale = { ...object(transform.scale), [field === "scaleX" ? "x" : "y"]: value! };
    } else transform[field] = field === "rotation" ? value! * Math.PI / 180 : value!;
  }
  if (kind === "target") arguments_.transform = transform;
  return arguments_;
}

/** One audition owns the preview until restored or applied. Source stays untouched while auditioning. */
export class StageTransformEdit {
  readonly node: AltairAuthoredNode;
  readonly kind: "stage" | "target";
  private readonly initial;
  private readonly document: EditorDocument | undefined;
  private readonly compilation;
  private readonly runtimeCommand: JsonObject;
  private readonly commandIndex: number;
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private draftSequence = 0;
  private closed = false;
  private cancelTask: Promise<void> | undefined;
  private readonly identity = crypto.randomUUID();
  private readonly controller = new AbortController();
  private readonly unsubscribe: () => void;

  constructor(private readonly session: EditorSession, private readonly bridge: StudioPreviewBridge) {
    this.initial = session.getSnapshot();
    this.document = session.document();
    const node = session.statements().find(statement => statement.id === this.initial.selectedNodeId)?.node;
    const kind = transformKind(node);
    if (!node || !kind || !this.document || !this.initial.compilation || this.initial.compiling ||
        this.initial.error || this.initial.nativeImportRecovery || session.lifetimeSignal.aborted)
      throw new Error("Select a WebGAL transform statement");
    this.node = node;
    this.kind = kind;
    this.compilation = this.initial.compilation;
    const sourceIndex = this.initial.project?.scenes.find(scene => scene.id === this.compilation.sceneId)
      ?.commands.findIndex(command => command.id === node.id);
    const mapping = this.compilation.commandMappings.find(mapping => mapping.sceneId === this.compilation.sceneId &&
      mapping.sourceCommandIndex === sourceIndex);
    if (!mapping) throw new Error("Transform preview is not synchronized");
    this.commandIndex = mapping.commandIndex;
    const command = object(object(this.compilation.story).commands instanceof Array
      ? (object(this.compilation.story).commands as unknown[])[this.commandIndex] : undefined);
    const expected = kind === "stage" ? WEBGAL_COMMAND_TYPES.stageTransform : WEBGAL_COMMAND_TYPES.setTransform;
    if (command.command !== expected) throw new Error("Transform preview is not synchronized");
    this.runtimeCommand = command;
    const unsubscribe = session.subscribe(() => {
      if (!this.matches()) this.invalidate();
    });
    const abort = () => this.invalidate();
    this.unsubscribe = () => {
      unsubscribe();
      session.lifetimeSignal.removeEventListener("abort", abort);
    };
    session.lifetimeSignal.addEventListener("abort", abort, { once: true });
  }

  matches(): boolean {
    const state = this.session.getSnapshot();
    return !this.session.lifetimeSignal.aborted && state.id === this.initial.id && state.contextEpoch === this.initial.contextEpoch &&
      state.active === this.initial.active && state.selectedNodeId === this.initial.selectedNodeId &&
      state.documents === this.initial.documents &&
      state.compilation === this.compilation && !state.nativeImportRecovery &&
      this.session.document()?.revision === this.document!.revision;
  }

  private async restore(commandIndex = this.commandIndex + 1): Promise<void> {
    if (!this.matches()) return;
    const executed = await this.bridge.syncScene(this.compilation.sceneId, `transform:${this.identity}:${++this.sequence}`,
      this.compilation.story, commandIndex, this.controller.signal);
    if (!executed) throw new Error("Transform preview was superseded");
  }

  begin(): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.closed || !this.matches()) return;
      await this.bridge.pause(this.controller.signal);
      if (this.closed || !this.matches()) return;
      await this.restore();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async preview(draft: TransformDraft): Promise<void> {
    const arguments_ = transformArguments(this.node, draft);
    const draftSequence = ++this.draftSequence;
    const operation = async () => {
      if (this.closed || !this.matches() || draftSequence !== this.draftSequence) return;
      await this.restore(this.commandIndex);
      if (this.closed || !this.matches() || draftSequence !== this.draftSequence) return;
      await this.bridge.runSnippet([{ ...this.runtimeCommand, ...arguments_, durationMs: 0 }],
        "WebGAL transform audition", this.controller.signal);
    };
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async apply(draft: TransformDraft): Promise<void> {
    const arguments_ = transformArguments(this.node, draft);
    if (this.closed) throw new Error("Transform edit is closed");
    this.closed = true;
    try {
      await this.queue;
      if (!this.matches()) throw new Error("Scene changed during transform editing");
      this.session.endGesture();
      this.session.editNode(this.node.id, node => ({ ...node, arguments: arguments_ }));
      this.session.endGesture();
    } finally {
      this.unsubscribe();
      this.controller.abort();
    }
  }

  invalidate(): void {
    this.closed = true;
    this.unsubscribe();
    this.controller.abort();
  }

  cancel(): Promise<void> {
    if (this.cancelTask) return this.cancelTask;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const task = (async () => {
      await this.queue;
      try {
        await this.restore();
      } catch (error) {
        if (this.matches() && !this.controller.signal.aborted) this.closed = false;
        throw error;
      }
      this.unsubscribe();
      this.controller.abort();
    })();
    this.cancelTask = task;
    const clear = () => {
      if (this.cancelTask === task) this.cancelTask = undefined;
    };
    void task.then(clear, clear);
    return task;
  }
}
