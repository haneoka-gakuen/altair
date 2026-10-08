import { cloneStoryValue, type JsonObject, type JsonValue } from "@haneoka/altair/model";
import { WEBGAL_COMMAND_TYPES } from "@haneoka/vega-plugin-webgal/commands";
import type { VegaPreviewBreakpoint, VegaPreviewIdentity } from "@haneoka/altair-preview-client";
import type { StudioPreviewBridge } from "../preview-bridge";
import type { EditorSession, EditorSnapshot } from "./session";
import { animationFramesTimeline, readAnimationFrames } from "./webgal-animation-frames";

export interface AnimationAuditionState {
  readonly ready: boolean;
  readonly owned: boolean;
  readonly phase: "idle" | "starting" | "playing" | "paused" | "restoring" | "error";
  readonly busy: boolean;
  readonly nodeId?: string;
  readonly trialId?: string;
  readonly restoredTrialId?: string;
  readonly restoredNodeId?: string;
  readonly error: string;
  readonly message: string;
}
interface Trial {
  readonly id: string;
  readonly snapshot: EditorSnapshot;
  readonly nodeId: string;
  readonly source: JsonObject;
  readonly candidate: JsonObject;
  readonly sceneId: string;
  readonly index: number;
  readonly candidateRevision: string;
  readonly startAbort: AbortController;
  baseline?: { readonly index: number; readonly breakpoints: readonly VegaPreviewBreakpoint[] };
  stopRequested: boolean;
  candidateArmed: boolean;
  completionSignalled: boolean;
  runtimeIdentity?: VegaPreviewIdentity;
  minimumRuntimeRevision?: number;
}
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Temporary runtime ownership. Every story mutation here goes through the public preview port. */
export class AnimationAudition {
  private state: AnimationAuditionState = { ready: false, owned: false, phase: "idle", busy: false, error: "", message: "" };
  private readonly listeners = new Set<() => void>();
  private trial: Trial | undefined;
  private tail: Promise<void> = Promise.resolve();
  private stopTask: Promise<void> | undefined;
  private completionTask: Promise<void> | undefined;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(
    private readonly session: EditorSession,
    private readonly bridge: StudioPreviewBridge,
    private readonly mount: HTMLElement,
    private readonly lifetime: AbortSignal,
    private readonly resetPreview: (breakpoints: readonly VegaPreviewBreakpoint[] | undefined) => void,
  ) {
    this.unsubscribe = session.subscribe(() => {
      if (this.trial && !this.matches(this.trial)) this.invalidate();
    });
    this.unsubscribeEvents = bridge.onEvent(event => {
      const trial = this.trial;
      if (trial && trial.candidateArmed && !trial.stopRequested && this.matches(trial) && event.event === "runtime.stopped" &&
          event.revision >= trial.minimumRuntimeRevision! && this.sameIdentity(event.identity, trial.runtimeIdentity) &&
          event.reason === "breakpoint" && event.sceneId === trial.sceneId && event.commandIndex === trial.index + 1) {
        trial.completionSignalled = true;
        void this.checkCompletion(trial);
      }
      if (trial && event.event === "runtime.diagnostic" && event.level === "error" && !trial.stopRequested)
        void this.enqueue(async () => {
          if (this.trial !== trial || !this.matches(trial) || trial.stopRequested) return;
          const state = object(await this.command(trial, { name: "stage.snapshot" }));
          if (state.sceneRevision === trial.candidateRevision)
            this.publish({ phase: "error", busy: false, error: event.message, message: "Animation audition failed" });
        }).catch(() => undefined);
    });
    lifetime.addEventListener("abort", this.dispose, { once: true });
    session.lifetimeSignal.addEventListener("abort", this.dispose, { once: true });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  setReady(ready: boolean): void { if (this.state.ready !== ready) this.publish({ ready }); }
  private publish(patch: Partial<AnimationAuditionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private matches(trial: Trial): boolean {
    const now = this.session.getSnapshot();
    return !this.disposed && !this.lifetime.aborted && !this.session.lifetimeSignal.aborted &&
      !now.nativeImportRecovery && now.id === trial.snapshot.id && now.contextEpoch === trial.snapshot.contextEpoch &&
      now.active === trial.snapshot.active && now.selectedNodeId === trial.nodeId &&
      now.documents === trial.snapshot.documents && now.compilation === trial.snapshot.compilation;
  }
  private assert(trial: Trial): void {
    if (this.trial !== trial || !this.matches(trial)) throw new DOMException("Animation audition context changed", "AbortError");
  }
  private sameIdentity(identity: VegaPreviewIdentity, expected?: VegaPreviewIdentity): boolean {
    return Boolean(expected && identity.workspaceId === expected.workspaceId && identity.projectId === expected.projectId &&
      identity.editorSessionId === expected.editorSessionId && identity.runtimeInstanceId === expected.runtimeInstanceId);
  }
  private signal(): AbortSignal { return AbortSignal.any([this.lifetime, this.session.lifetimeSignal]); }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async command(trial: Trial, command: Parameters<StudioPreviewBridge["auditionCommand"]>[0], signal = this.signal()) {
    this.assert(trial);
    const result = await this.bridge.auditionCommand(command, signal);
    this.assert(trial);
    return result;
  }
  private async visible(signal: AbortSignal): Promise<void> {
    const visible = () => this.mount.getBoundingClientRect().width > 0 && this.mount.getBoundingClientRect().height > 0;
    signal.throwIfAborted();
    if (visible()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        observer.disconnect(); clearTimeout(timeout); signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const observer = new ResizeObserver(() => { if (visible()) finish(); });
      const timeout = setTimeout(() => finish(new Error("Open the preview page before auditioning animation")), 8_000);
      const aborted = () => finish(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      observer.observe(this.mount);
      if (signal.aborted) aborted();
    });
  }

  start(nodeId: string, values: readonly JsonObject[]): Promise<void> {
    if (this.disposed || !this.state.ready || this.trial || this.stopTask) return Promise.reject(new Error("Animation preview is not available"));
    const snapshot = this.session.getSnapshot(), compilation = snapshot.compilation;
    if (!compilation || snapshot.compiling || snapshot.saving || snapshot.error || snapshot.nativeImportRecovery ||
        snapshot.selectedNodeId !== nodeId || snapshot.documents.some(doc => doc.text !== doc.baseline))
      return Promise.reject(new Error("Save the scene before auditioning animation drafts"));
    const node = this.session.statements().find(statement => statement.id === nodeId)?.node;
    if (node?.type.plugin !== "haneoka.altair-webgal" || node.type.name !== "effect.setTempAnimation")
      return Promise.reject(new Error("Select an animation statement"));
    const frames = readAnimationFrames([...values]);
    animationFramesTimeline(frames);
    const sourceIndex = snapshot.project?.scenes.find(scene => scene.id === compilation.sceneId)?.commands.findIndex(command => command.id === nodeId);
    const mapping = compilation.commandMappings.find(mapping => mapping.sceneId === compilation.sceneId && mapping.sourceCommandIndex === sourceIndex);
    const source = cloneStoryValue(object(compilation.story)), commands = source.commands;
    if (!mapping || !Array.isArray(commands) || object(commands[mapping.commandIndex]).command !== WEBGAL_COMMAND_TYPES.setTempAnimation)
      return Promise.reject(new Error("Animation preview is not synchronized"));
    const candidate = cloneStoryValue(source), candidateCommands = candidate.commands as JsonValue[];
    // Isolate command completion; effect options and authoring noWait remain unchanged.
    candidateCommands[mapping.commandIndex] = { ...object(candidateCommands[mapping.commandIndex]), frames, noWait: false };
    const id = crypto.randomUUID();
    const trial: Trial = { id, snapshot, nodeId, source, candidate, sceneId: compilation.sceneId, index: mapping.commandIndex,
      candidateRevision: `altair:animation-draft:${id}`, startAbort: new AbortController(), stopRequested: false,
      candidateArmed: false, completionSignalled: false };
    this.trial = trial;
    this.completionTask = undefined;
    this.publish({ owned: true, phase: "starting", busy: true, nodeId, trialId: id,
      restoredTrialId: undefined, restoredNodeId: undefined, error: "", message: "Starting animation audition" });
    return this.enqueue(async () => {
      const signal = AbortSignal.any([this.signal(), trial.startAbort.signal]);
      try {
        await this.visible(signal);
        await this.command(trial, { name: "runtime.pause" }, signal);
        const baseline = object(await this.command(trial, { name: "stage.snapshot" }, signal));
        const execution = object(baseline.execution);
        const breakpoints = execution.breakpoints;
        if (baseline.sceneId !== trial.sceneId || !Number.isSafeInteger(baseline.commandIndex) ||
            Number(baseline.commandIndex) < 0 || !Array.isArray(breakpoints)) throw new Error("Animation preview is not synchronized");
        const configured = this.bridge.configuredBreakpoints;
        // The runtime snapshot enumerates only active indices, not disabled/other-scene settings.
        // Preserve the complete configuration recorded on this owned Studio channel.
        const active = configured?.filter(point => point.enabled !== false && (!point.sceneId || point.sceneId === trial.sceneId))
          .map(point => point.commandIndex).sort((a, b) => a - b);
        const observed = [...breakpoints].sort((a, b) => Number(a) - Number(b));
        if (!configured || JSON.stringify(active) !== JSON.stringify(observed))
          throw new Error("Refresh preview before auditioning with an unknown breakpoint configuration");
        trial.baseline = { index: Number(baseline.commandIndex), breakpoints: configured };
        await this.command(trial, { name: "debug.breakpoints.set", breakpoints: [{ sceneId: trial.sceneId, commandIndex: trial.index + 1, enabled: true }] }, signal);
        this.assert(trial);
        const receipt = await this.bridge.auditionCommandReceipt({ name: "editor.sync-scene", sceneId: trial.sceneId,
          sceneRevision: trial.candidateRevision, story: trial.candidate, commandIndex: trial.index }, signal);
        this.assert(trial);
        trial.runtimeIdentity = receipt.identity;
        trial.minimumRuntimeRevision = receipt.revision;
        // Arm only after the candidate sync ACK; earlier source events precede this ACK on the owned port.
        trial.candidateArmed = true;
        await this.command(trial, { name: "editor.run-from", commandIndex: trial.index }, signal);
        this.publish({ phase: "playing", busy: false, message: "Playing animation draft" });
        void this.checkCompletion(trial);
      } catch (error) {
        if (this.trial === trial && this.matches(trial) && !trial.stopRequested)
          this.publish({ phase: "error", busy: false, error: failure(error), message: "Animation audition failed" });
        throw error;
      }
    });
  }

  private checkCompletion(trial: Trial): Promise<void> {
    if (this.trial !== trial || !trial.completionSignalled || trial.stopRequested) return Promise.resolve();
    if (this.completionTask) return this.completionTask;
    let completed = false;
    const task = this.enqueue(async () => {
      if (this.trial !== trial || !trial.completionSignalled || trial.stopRequested) return;
      const state = object(await this.command(trial, { name: "stage.snapshot" }));
      completed = this.isCompletionBoundary(trial, state);
    }).then(async () => {
      if (completed && this.trial === trial && !trial.stopRequested)
        await this.stop("Animation audition completed; original preview restored");
    }).catch(error => {
      if (this.trial === trial && this.matches(trial) && !trial.stopRequested)
        this.publish({ phase: "error", busy: false, error: failure(error) });
    });
    this.completionTask = task;
    const clear = () => { if (this.completionTask === task) this.completionTask = undefined; };
    void task.then(clear, clear);
    return task;
  }
  pause(): Promise<void> { return this.playback(false); }
  resume(): Promise<void> { return this.playback(true); }
  private playback(play: boolean): Promise<void> {
    const trial = this.trial;
    if (!trial || this.state.busy || !(play ? this.state.phase === "paused" : this.state.phase === "playing"))
      return Promise.reject(new Error("Animation audition is not ready for this action"));
    this.publish({ busy: true });
    let restoreCompletion = false;
    return this.enqueue(async () => {
      try {
        if (trial.stopRequested) return;
        if (play) {
          const before = object(await this.command(trial, { name: "stage.snapshot" }));
          this.assertCandidateBoundary(trial, before);
          if (trial.completionSignalled) {
            if (!this.isCompletionBoundary(trial, before)) throw new Error("Animation audition was superseded");
            restoreCompletion = true;
            return;
          }
          // Progress already points to index+1 while the animation promise is still executing.
          // Only resume the same paused live playback; never a stopped/finished boundary waiter.
          if (Number(before.commandIndex) > trial.index + 1 || object(before.execution).paused !== true ||
              object(before.execution).playing !== true)
            throw new Error("Animation audition is not ready for this action");
        }
        await this.command(trial, { name: play ? "runtime.play" : "runtime.pause" });
        if (!play && !trial.stopRequested) {
          const paused = object(await this.command(trial, { name: "stage.snapshot" }));
          this.assertCandidateBoundary(trial, paused);
          if (trial.completionSignalled) {
            if (!this.isCompletionBoundary(trial, paused)) throw new Error("Animation audition was superseded");
            restoreCompletion = true;
            return;
          }
        }
        if (!trial.stopRequested) this.publish({ phase: play ? "playing" : "paused", busy: false,
          message: play ? "Playing animation draft" : "Animation draft paused", error: "" });
        if (play) void this.checkCompletion(trial);
      } catch (error) {
        if (this.trial === trial && this.matches(trial) && !trial.stopRequested)
          this.publish({ phase: "error", busy: false, error: failure(error) });
        throw error;
      }
    }).then(async () => {
      if (restoreCompletion && this.trial === trial && !trial.stopRequested)
        await this.stop("Animation audition completed; original preview restored");
    });
  }
  private assertCandidateBoundary(trial: Trial, state: JsonObject): void {
    if (state.sceneId !== trial.sceneId || state.sceneRevision !== trial.candidateRevision ||
        !Number.isSafeInteger(state.commandIndex) || Number(state.commandIndex) < trial.index)
      throw new Error("Animation audition was superseded");
  }
  private isCompletionBoundary(trial: Trial, state: JsonObject): boolean {
    return state.sceneId === trial.sceneId && state.sceneRevision === trial.candidateRevision &&
      state.commandIndex === trial.index + 1 && object(state.execution).paused === true;
  }
  stop(message = "Original preview restored"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const trial = this.trial;
    if (!trial) return Promise.resolve();
    trial.stopRequested = true;
    trial.startAbort.abort(new DOMException("Animation audition stopped", "AbortError"));
    this.publish({ phase: "restoring", busy: true, error: "", message: "Restoring original preview" });
    const task = this.enqueue(async () => {
      try {
        this.assert(trial);
        if (trial.baseline) {
          await this.command(trial, { name: "runtime.pause" });
          await this.command(trial, { name: "editor.sync-scene", sceneId: trial.sceneId,
            sceneRevision: `altair:animation-restore:${crypto.randomUUID()}`, story: trial.source, commandIndex: trial.baseline.index });
          await this.command(trial, { name: "debug.breakpoints.set", breakpoints: trial.baseline.breakpoints });
        }
        this.trial = undefined;
        this.publish({ owned: false, phase: "idle", busy: false, nodeId: undefined, trialId: undefined,
          restoredTrialId: trial.id, restoredNodeId: trial.nodeId, error: "", message });
      } catch (error) {
        if (this.trial === trial && this.matches(trial)) this.publish({ phase: "error", busy: false, error: failure(error), message: "Original preview could not be restored" });
        throw error;
      }
    });
    this.stopTask = task;
    const clear = () => { if (this.stopTask === task) this.stopTask = undefined; };
    void task.then(clear, clear);
    return task;
  }
  private invalidate(): void {
    const trial = this.trial;
    if (!trial) return;
    trial.startAbort.abort(new DOMException("Animation audition context changed", "AbortError"));
    this.trial = undefined;
    this.publish({ owned: false, ready: false, phase: "idle", busy: false, nodeId: undefined, trialId: undefined,
      restoredTrialId: undefined, restoredNodeId: undefined, error: "", message: "Animation audition cancelled after context change" });
    const now = this.session.getSnapshot();
    const sameAccountProject = now.id === trial.snapshot.id && now.contextEpoch === trial.snapshot.contextEpoch;
    // Dispose the candidate connection. The new connection syncs current authoring state, never a stale captured story.
    this.resetPreview(sameAccountProject ? trial.baseline?.breakpoints : undefined);
  }
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.trial?.startAbort.abort();
    this.trial = undefined;
    // Session disposal can await persistence or fail before React unmounts Preview.
    // Terminate the actual candidate connection before releasing UI ownership.
    this.bridge.close();
    this.unsubscribe(); this.unsubscribeEvents();
    this.lifetime.removeEventListener("abort", this.dispose);
    this.session.lifetimeSignal.removeEventListener("abort", this.dispose);
    this.publish({ owned: false, ready: false, phase: "idle", busy: false, nodeId: undefined, trialId: undefined,
      restoredTrialId: undefined, restoredNodeId: undefined });
    this.listeners.clear();
  };
}
