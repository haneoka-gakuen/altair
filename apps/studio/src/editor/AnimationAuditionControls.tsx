import { useSyncExternalStore } from "react";
import "./animation-audition.css";
import type { EditorSession } from "./session";
import { tr } from "./i18n";

export function AnimationAuditionControls({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot).animationAudition;
  const service = session.animationAudition;
  if (!state || (!state.owned && !state.message && !state.error)) return null;
  return <section className="animation-audition-controls" aria-label={tr("Animation draft audition")}>
    <p role="status">{tr(state.message)}</p>
    {state.owned ? <div role="group" aria-label={tr("Animation audition playback")}>
      <button type="button" className="secondary-button" disabled={state.busy || state.phase !== "playing"}
        onClick={() => void service?.pause().catch(() => undefined)}>{tr("Pause animation audition")}</button>
      <button type="button" className="secondary-button" disabled={state.busy || state.phase !== "paused"}
        onClick={() => void service?.resume().catch(() => undefined)}>{tr("Resume animation audition")}</button>
      <button type="button" className="secondary-button" disabled={state.phase === "restoring"}
        onClick={() => void service?.stop().catch(() => undefined)}>
        {tr(state.phase === "error" ? "Retry restoring preview" : "Stop animation audition")}
      </button>
    </div> : null}
    {state.error ? <p role="alert">{tr(state.error)}</p> : null}
  </section>;
}
