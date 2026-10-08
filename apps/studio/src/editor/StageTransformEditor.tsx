import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./stage-transform-editor.css";
import { NumberInput } from "@haneoka/altair-ui-react";
import type { StudioPreviewBridge } from "../preview-bridge";
import type { EditorSession } from "./session";
import { tr } from "./i18n";
import { StageTransformEdit, authoredTransformValue, transformFields, transformKind, transformValue, type TransformDraft } from "./stage-transform";

export function StageTransformEditor({ session, bridge, ready, onEditingChange }: {
  session: EditorSession;
  bridge: StudioPreviewBridge;
  ready: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const owner = useRef<StageTransformEdit | undefined>(undefined);
  const draftRevision = useRef(0);
  const [edit, setEdit] = useState<StageTransformEdit>();
  const [draft, setDraft] = useState<TransformDraft>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = session.statements().find(statement => statement.id === state.selectedNodeId)?.node;
  const supported = Boolean(transformKind(selected));

  useEffect(() => {
    setEdit(undefined);
    setBusy(false);
    setError("");
    onEditingChange(false);
    const changed = () => {
      const current = owner.current;
      if (current && !current.matches()) {
        current.invalidate();
        owner.current = undefined;
        setEdit(undefined);
        setBusy(false);
        onEditingChange(false);
      }
    };
    const unsubscribe = session.subscribe(changed);
    session.lifetimeSignal.addEventListener("abort", changed, { once: true });
    return () => {
      unsubscribe();
      session.lifetimeSignal.removeEventListener("abort", changed);
      const current = owner.current;
      owner.current = undefined;
      void current?.cancel().catch(() => current.invalidate());
    };
  }, [session, onEditingChange]);

  const close = () => {
    owner.current = undefined;
    setEdit(undefined);
    setBusy(false);
    setError("");
    onEditingChange(false);
  };
  const finish = async (apply: boolean) => {
    if (!edit || busy) return;
    setBusy(true);
    try {
      if (apply && Object.keys(draft).length) await edit.apply(draft);
      else await edit.cancel();
      if (owner.current === edit) close();
    } catch (reason) {
      if (owner.current === edit) {
        setError(reason instanceof Error ? tr(reason.message) : String(reason));
        setBusy(false);
      }
    }
  };
  if (!supported && !edit) return null;
  return <div className="stage-transform-editor">
    {!edit ? <button disabled={!ready || !supported || state.compiling || Boolean(state.error) || Boolean(state.nativeImportRecovery)}
      title={tr("Select a WebGAL transform statement")}
      onClick={() => {
        try {
          const next = new StageTransformEdit(session, bridge);
          owner.current = next;
          setEdit(next);
          setDraft({});
          setError("");
          setBusy(true);
          onEditingChange(true);
          void next.begin().then(() => {
            if (owner.current === next) setBusy(false);
          }).catch(reason => {
            if (owner.current === next) {
              setError(reason instanceof Error ? tr(reason.message) : String(reason));
              setBusy(false);
            }
          });
        } catch (reason) { setError(reason instanceof Error ? tr(reason.message) : String(reason)); }
      }}>{tr("Adjust transform in preview")}</button> : <section aria-label={tr("Transform audition")}>
        <p>{tr("Preview changes, then apply them to the selected statement.")}</p>
        <p>{tr("Only changed fields are written. Unset fields keep their inherited values.")}</p>
        <div className="transform-fields">
          {transformFields.filter(field => edit.kind !== "stage" || (field.key !== "scaleY" && field.key !== "alpha"))
            .map(field => <label key={field.key}>
              <span>{tr(edit.kind === "stage" && field.key === "scaleX" ? "Scale" : field.label)}</span>
              {draft[field.key] === undefined && authoredTransformValue(edit.node, field.key) === undefined
                ? <small>{tr("Inherited (default shown)")}</small> : null}
              <NumberInput disabled={busy} step={field.step}
                value={Number((draft[field.key] ?? transformValue(edit.node, field.key)).toFixed(6))}
                onCommit={value => {
                  const next = { ...draft, [field.key]: value };
                  const revision = ++draftRevision.current;
                  setDraft(next);
                  setError("");
                  void edit.preview(next).catch(reason => {
                    if (owner.current === edit && draftRevision.current === revision)
                      setError(reason instanceof Error ? tr(reason.message) : String(reason));
                  });
                }} />
            </label>)}
        </div>
        <button disabled={busy || Boolean(error)} onClick={() => void finish(true)}>{tr("Apply to statement")}</button>
        <button disabled={busy} onClick={() => void finish(false)}>{tr("Cancel")}</button>
      </section>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
