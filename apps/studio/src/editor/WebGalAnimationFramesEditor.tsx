import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import "./webgal-animation-frames-editor.css";
import { NumberInput } from "@haneoka/altair-ui-react";
import { parseAuthoredText, serializeAuthoredText, type JsonObject } from "@haneoka/altair";
import type { EditorSession, EditorSnapshot } from "./session";
import { tr } from "./i18n";
import {
  readAnimationFrames, insertAnimationFrame, duplicateAnimationFrame, deleteAnimationFrame, moveAnimationFrame,
  setAnimationFrameDuration, setAnimationFrameEase, setAnimationFrameTransform, animationFrameTransformValue,
  animationFramesTimeline, type AnimationFramesChange, type AnimationTransformField,
} from "./webgal-animation-frames";

interface AnimationEditOwner {
  readonly snapshot: EditorSnapshot;
  readonly revision: number;
}
const fields: readonly { key: AnimationTransformField; label: string }[] = [
  { key: "x", label: "Position X (px)" }, { key: "y", label: "Position Y (px)" },
  { key: "scaleX", label: "Scale X" }, { key: "scaleY", label: "Scale Y" },
  { key: "rotation", label: "Rotation (degrees)" }, { key: "alpha", label: "Opacity" },
];

export function WebGalAnimationFramesEditor({ session, nodeId }: { session: EditorSession; nodeId: string }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const owner = useRef<AnimationEditOwner | undefined>(undefined);
  const currentDraft = useRef<AnimationFramesChange | undefined>(undefined);
  const issue = useRef("");
  const numericIssue = useRef(false);
  const rawInvalid = useRef(false);
  const selectionVersion = useRef(0);
  const [draft, setDraft] = useState<AnimationFramesChange>();
  const [rawText, setRawText] = useState<string>();
  const [rawOpen, setRawOpen] = useState(false);
  const [error, setError] = useState("");
  const [operationError, setOperationError] = useState("");
  const operationIssue = useRef<{ owner: AnimationEditOwner; trialId?: string; actionId: number } | undefined>(undefined);
  const operationAction = useRef(0);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const rawRegionId = useId();
  const renderedSelectionVersion = selectionVersion.current;

  const matches = useCallback((captured: AnimationEditOwner) => {
    const now = session.getSnapshot();
    return !session.lifetimeSignal.aborted && !now.nativeImportRecovery &&
      now.id === captured.snapshot.id && now.contextEpoch === captured.snapshot.contextEpoch &&
      now.active === captured.snapshot.active && now.selectedNodeId === nodeId &&
      now.documents === captured.snapshot.documents && session.document()?.revision === captured.revision;
  }, [session, nodeId]);
  const setIssue = useCallback((value: string, numeric = false) => {
    issue.current = value;
    numericIssue.current = numeric;
    setError(value);
  }, []);
  const clearOperationIssue = useCallback(() => {
    operationIssue.current = undefined;
    setOperationError("");
  }, []);
  const setOperationIssue = useCallback((captured: AnimationEditOwner, reason: unknown, actionId: number) => {
    if (owner.current !== captured || !matches(captured) || actionId !== operationAction.current) return;
    operationIssue.current = { owner: captured, trialId: session.getSnapshot().animationAudition?.trialId, actionId };
    setOperationError(reason instanceof Error ? tr(reason.message) : String(reason));
  }, [session, matches]);
  const prepareOperation = (captured: AnimationEditOwner): number | undefined => {
    if (owner.current !== captured || !matches(captured)) return;
    const pending = operationIssue.current;
    if (pending) {
      if (pending.owner !== captured || pending.trialId || session.getSnapshot().animationAudition?.owned) return;
      // A preflight rejection never acquired runtime ownership. This explicit user action retries it.
      clearOperationIssue();
    }
    return ++operationAction.current;
  };
  const close = useCallback(() => {
    operationAction.current++;
    owner.current = undefined;
    currentDraft.current = undefined;
    rawInvalid.current = false;
    setDraft(undefined);
    setRawText(undefined);
    setRawOpen(false);
    setIssue("");
    clearOperationIssue();
  }, [setIssue, clearOperationIssue]);
  useEffect(() => {
    close();
    const changed = () => {
      if (owner.current && !matches(owner.current)) close();
      const pending = operationIssue.current, playback = session.getSnapshot().animationAudition;
      if (pending && owner.current === pending.owner && matches(pending.owner) && pending.trialId &&
          playback?.phase === "idle" && !playback.owned && !playback.error &&
          playback.restoredTrialId === pending.trialId && playback.restoredNodeId === nodeId)
        clearOperationIssue();
    };
    const unsubscribe = session.subscribe(changed);
    session.lifetimeSignal.addEventListener("abort", changed, { once: true });
    return () => {
      unsubscribe();
      session.lifetimeSignal.removeEventListener("abort", changed);
      owner.current = undefined;
      currentDraft.current = undefined;
      void session.stopAnimationAudition(nodeId).catch(() => undefined);
    };
  }, [session, nodeId, matches, close, clearOperationIssue]);

  const store = (next: AnimationFramesChange) => {
    animationFramesTimeline(next.frames);
    currentDraft.current = next;
    setDraft(next);
  };
  const mutate = (operation: (value: AnimationFramesChange) => AnimationFramesChange, structural = false) => {
    if (!owner.current || !matches(owner.current) || !currentDraft.current || rawInvalid.current || applyingRef.current) return;
    try {
      const next = operation(currentDraft.current);
      animationFramesTimeline(next.frames);
      if (structural) selectionVersion.current++;
      store(next);
      setRawText(undefined);
      setIssue("");
    } catch (reason) { setIssue(reason instanceof Error ? tr(reason.message) : String(reason), true); }
  };
  const mutateFrame = (operation: (value: AnimationFramesChange) => AnimationFramesChange) => {
    if (selectionVersion.current !== renderedSelectionVersion || currentDraft.current?.selectedIndex !== draft?.selectedIndex) return;
    mutate(operation);
  };
  const numberBlur = (event: FocusEvent<HTMLInputElement>, duration = false) => {
    if (!owner.current || !matches(owner.current) || rawInvalid.current ||
        selectionVersion.current !== renderedSelectionVersion) return;
    if (!event.currentTarget.validity.valid)
      setIssue(tr(duration ? "Animation duration must be a finite nonnegative number of milliseconds" :
        "Animation transform values must be finite"), true);
    else if (numericIssue.current) setIssue("");
  };

  const begin = () => {
    const snapshot = session.getSnapshot(), document = session.document();
    if (!document || snapshot.selectedNodeId !== nodeId || snapshot.nativeImportRecovery || session.lifetimeSignal.aborted) return;
    const node = session.statements().find(statement => statement.id === nodeId)?.node;
    if (node?.type.plugin !== "haneoka.altair-webgal" || node.type.name !== "effect.setTempAnimation") return;
    owner.current = { snapshot, revision: document.revision };
    clearOperationIssue();
    const value = node.arguments.frames ?? [];
    try {
      const frames = readAnimationFrames(value);
      selectionVersion.current++;
      store({ frames, selectedIndex: frames.length ? 0 : undefined });
      rawInvalid.current = false;
      setRawText(undefined);
      setRawOpen(false);
      setIssue("");
    } catch (reason) {
      const next = { frames: [], selectedIndex: undefined };
      currentDraft.current = next;
      setDraft(next);
      rawInvalid.current = true;
      setRawOpen(true);
      setRawText(serializeAuthoredText(value));
      setIssue(reason instanceof Error ? tr(reason.message) : String(reason));
    }
  };
  const apply = async () => {
    const captured = owner.current, value = currentDraft.current;
    if (!captured || !value || issue.current || rawInvalid.current || applyingRef.current) return;
    if (!matches(captured)) { close(); return; }
    const actionId = prepareOperation(captured);
    if (actionId === undefined) return;
    let restoring = false;
    try {
      applyingRef.current = true;
      setApplying(true);
      const frames = readAnimationFrames(value.frames);
      animationFramesTimeline(frames);
      restoring = true;
      await session.stopAnimationAudition(nodeId);
      restoring = false;
      if (owner.current !== captured || !matches(captured)) return;
      session.endGesture();
      session.editNode(nodeId, node => ({ ...node, arguments: { ...node.arguments, frames } }));
      session.endGesture();
      close();
    } catch (reason) {
      if (restoring) setOperationIssue(captured, reason, actionId);
      else if (owner.current === captured) setIssue(reason instanceof Error ? tr(reason.message) : String(reason));
    } finally { applyingRef.current = false; setApplying(false); }
  };
  const cancel = async () => {
    if (applyingRef.current) return;
    const captured = owner.current;
    const actionId = ++operationAction.current;
    applyingRef.current = true;
    setApplying(true);
    try {
      await session.stopAnimationAudition(nodeId);
      if (owner.current === captured) close();
    } catch (reason) {
      if (captured) setOperationIssue(captured, reason, actionId);
    } finally { applyingRef.current = false; setApplying(false); }
  };
  const preview = async () => {
    const captured = owner.current, value = currentDraft.current;
    if (!captured || !value || !matches(captured) || issue.current || rawInvalid.current || applyingRef.current) return;
    const actionId = prepareOperation(captured);
    if (actionId === undefined) return;
    let frames: JsonObject[];
    try { frames = readAnimationFrames(value.frames); }
    catch (reason) { setIssue(reason instanceof Error ? tr(reason.message) : String(reason)); return; }
    try { await session.auditionAnimationDraft(nodeId, frames); }
    catch (reason) {
      if (owner.current === captured && matches(captured) && !(reason instanceof DOMException && reason.name === "AbortError"))
        setOperationIssue(captured, reason, actionId);
    }
  };
  const selected = draft?.selectedIndex, frame = selected === undefined ? undefined : draft?.frames[selected];
  const timeline = draft ? animationFramesTimeline(draft.frames) : [];
  const rawChange = (text: string) => {
    if (!owner.current || !matches(owner.current) || applyingRef.current) return;
    setRawText(text);
    try {
      const frames = readAnimationFrames(parseAuthoredText(text));
      for (const [index, next] of frames.entries()) {
        if (JSON.stringify(next.duration) === JSON.stringify(currentDraft.current?.frames[index]?.duration)) continue;
        if (next.duration !== undefined) {
          const duration = Number(next.duration);
          if (!Number.isFinite(duration) || duration < 0)
            throw new RangeError("Animation duration must be a finite nonnegative number of milliseconds");
        }
      }
      animationFramesTimeline(frames);
      selectionVersion.current++;
      store({ frames, selectedIndex: frames.length ? Math.min(currentDraft.current?.selectedIndex ?? 0, frames.length - 1) : undefined });
      rawInvalid.current = false;
      setIssue("");
    } catch (reason) {
      rawInvalid.current = true;
      setIssue(reason instanceof Error ? tr(reason.message) : String(reason));
    }
  };
  const frameValue = (value: JsonObject, key: AnimationTransformField) => {
    try { return animationFrameTransformValue(value, key); } catch { return undefined; }
  };
  const durationValue = frame && Object.hasOwn(frame, "duration") && Number.isFinite(Number(frame.duration)) && Number(frame.duration) >= 0
    ? Number(frame.duration) : undefined;
  const operationBlocked = Boolean(operationIssue.current &&
    (operationIssue.current.trialId || state.animationAudition?.owned));

  return <div className="webgal-animation-frames-editor">
    {!draft ? <button type="button" className="secondary-button"
      disabled={Boolean(state.nativeImportRecovery) || session.lifetimeSignal.aborted || state.selectedNodeId !== nodeId}
      onClick={begin}>{tr("Edit animation frames")}</button> : <section aria-label={tr("Animation keyframes")}>
      <p>{tr("Frame changes are saved to this statement when you apply them.")}</p>
      <div className="animation-frames-preview-actions" role="group" aria-label={tr("Animation draft preview")}>
        <button type="button" className="secondary-button" disabled={applying || Boolean(error) || operationBlocked || rawInvalid.current ||
          !state.animationAudition?.ready || state.animationAudition.owned || !draft.frames.length}
          onClick={() => void preview()}>{tr("Audition animation draft")}</button>
        {state.animationAudition?.owned && state.animationAudition.nodeId === nodeId ?
          <button type="button" className="secondary-button" disabled={state.animationAudition.phase === "restoring"}
            onClick={() => {
              const captured = owner.current;
              const actionId = ++operationAction.current;
              void session.stopAnimationAudition(nodeId).catch(reason => { if (captured) setOperationIssue(captured, reason, actionId); });
            }}>
            {tr("Stop animation audition")}</button> : null}
      </div>
      <div className="animation-frames-actions" role="group" aria-label={tr("Frame actions")}>
        <button type="button" disabled={rawInvalid.current} onClick={() => mutate(value => insertAnimationFrame(value.frames, value.selectedIndex), true)}>{tr("Add frame")}</button>
        <button type="button" disabled={rawInvalid.current || selected === undefined} onClick={() => mutate(value => duplicateAnimationFrame(value.frames, value.selectedIndex!), true)}>{tr("Duplicate frame")}</button>
        <button type="button" disabled={rawInvalid.current || selected === undefined} onClick={() => mutate(value => deleteAnimationFrame(value.frames, value.selectedIndex!), true)}>{tr("Delete frame")}</button>
        <button type="button" disabled={rawInvalid.current || selected === undefined || selected === 0} onClick={() => mutate(value => moveAnimationFrame(value.frames, value.selectedIndex!, value.selectedIndex! - 1), true)}>{tr("Move frame up")}</button>
        <button type="button" disabled={rawInvalid.current || selected === undefined || selected === draft.frames.length - 1} onClick={() => mutate(value => moveAnimationFrame(value.frames, value.selectedIndex!, value.selectedIndex! + 1), true)}>{tr("Move frame down")}</button>
      </div>
      <ol className="animation-frames-list" aria-label={tr("Animation frames")}>
        {draft.frames.map((_frame, index) => <li key={index}><button type="button" aria-pressed={index === selected}
          disabled={rawInvalid.current} onClick={() => mutate(value => ({ ...value, selectedIndex: index }), true)}>
          <span>{tr("Frame {{number}}", { number: index + 1 })}</span>
          <small>{tr("{{duration}} ms · ends at {{end}} ms", { duration: timeline[index]!.durationMs, end: timeline[index]!.endMs })}</small>
        </button></li>)}
      </ol>
      {frame && selected !== undefined ? <fieldset key={renderedSelectionVersion} className="animation-frame-fields" disabled={rawInvalid.current || applying}>
        <legend>{tr("Frame {{number}}", { number: selected + 1 })}</legend>
        <label><span>{tr("Duration (ms)")}</span><NumberInput min={0} step="any" value={durationValue} placeholder="0"
          onCommit={value => mutateFrame(draft => setAnimationFrameDuration(draft.frames, draft.selectedIndex!, value))}
          onClear={() => mutateFrame(value => {
            const frames = readAnimationFrames(value.frames);
            frames[value.selectedIndex!] = { ...frames[value.selectedIndex!]! };
            delete frames[value.selectedIndex!]!.duration;
            return { ...value, frames };
          })} onBlur={event => numberBlur(event, true)} /></label>
        <label><span>{tr("Easing")}</span><input value={typeof frame.ease === "string" ? frame.ease : ""}
          placeholder={tr("Default easing")} onChange={event => mutateFrame(value => setAnimationFrameEase(value.frames, value.selectedIndex!, event.target.value))} /></label>
        {fields.map(field => <label key={field.key}><span>{tr(field.label)}</span>
          <NumberInput step="any" value={frameValue(frame, field.key)} placeholder={tr("Inherited or raw value")}
            onCommit={value => mutateFrame(draft => setAnimationFrameTransform(draft.frames, draft.selectedIndex!, field.key, value))}
            onClear={() => mutateFrame(draft => setAnimationFrameTransform(draft.frames, draft.selectedIndex!, field.key, undefined))}
            onBlur={event => numberBlur(event)} /></label>)}
      </fieldset> : <p>{tr("Add a frame to start editing.")}</p>}
      <div className="animation-frames-raw">
        <button type="button" className="animation-frames-raw-toggle" aria-expanded={rawOpen}
          aria-controls={rawRegionId} onClick={() => setRawOpen(open => !open)}>{tr("All animation frame properties")}</button>
        <div id={rawRegionId} className="animation-frames-raw-region" role="region"
          aria-label={tr("All animation frame properties")} hidden={!rawOpen}>
          <textarea aria-label={tr("All animation frame properties")} rows={8}
            disabled={applying}
            value={rawText ?? serializeAuthoredText(draft.frames)} onChange={event => rawChange(event.target.value)} />
        </div>
      </div>
      <div className="animation-frames-footer">
        <button type="button" disabled={applying || Boolean(error) || operationBlocked || rawInvalid.current} onClick={() => void apply()}>{tr("Apply animation frames")}</button>
        <button type="button" disabled={applying} onClick={() => void cancel()}>{tr("Cancel")}</button>
      </div>
    </section>}
    {error || operationError ? <p role="alert">{error || operationError}</p> : null}
  </div>;
}
