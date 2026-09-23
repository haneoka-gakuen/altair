import { useEffect, useRef, useState } from "react";
import type { EditorSession } from "./session";
import { useStudioI18n } from "./i18n";
import type { JsonObject } from "@haneoka/altair";

export function PluginPanel({
  session,
  panelId,
  path,
  selection,
  inline = false,
}: {
  session: EditorSession;
  panelId: string;
  path: string;
  selection?: JsonObject;
  inline?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState("");
  const { i18n } = useStudioI18n();
  const pluginHost = session.editorHost;
  const selectionKey = JSON.stringify({ kind: inline ? "field" : "document", path, ...selection });
  useEffect(() => {
    if (!pluginHost || !host.current) return;
    const controller = new AbortController();
    let mounted: { dispose(): Promise<void> } | undefined;
    setError("");
    void pluginHost
      .mountPanel(panelId, host.current, {
        signal: controller.signal,
        selection: JSON.parse(selectionKey),
        editor: session.editorWorkspace,
      })
      .then(async (panel) => {
        if (controller.signal.aborted) await panel.dispose();
        else mounted = panel;
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error));
      });
    return () => {
      controller.abort();
      void mounted?.dispose();
    };
  }, [session, pluginHost, panelId, selectionKey, i18n.resolvedLanguage]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div className={inline ? "plugin-field-panel" : "plugin-document-panel"} ref={host} />
    </>
  );
}
