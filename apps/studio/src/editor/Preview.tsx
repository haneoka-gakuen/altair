import { tr } from "./i18n";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw, StepForward, Maximize2 } from "lucide-react";
import { createAltairVegaPreviewService, type AltairVegaPreviewService } from "@haneoka/altair-plugin-vega-preview";
import { StudioPreviewBridge } from "../preview-bridge";
import { createStudioPreviewPluginPlan, loadStudioPreviewPlugins, studioPreviewPluginHost } from "../preview-plugins";
import {
  DEFAULT_STUDIO_PROJECT_PLUGINS,
  STUDIO_PLUGIN_CATALOG,
  STUDIO_PLUGIN_ENVIRONMENT,
} from "../studio-plugin-catalog";
import type { EditorSession } from "./session";
export function Preview({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const pluginSignature = JSON.stringify(state.project?.plugins ?? DEFAULT_STUDIO_PROJECT_PLUGINS);
  const projectReady = Boolean(state.project);
  const mount = useRef<HTMLDivElement>(null),
    bridge = useRef(new StudioPreviewBridge());
  const [status, setStatus] = useState("Connecting preview"),
    [ready, setReady] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!projectReady) return;
    const controller = new AbortController();
    let service: AltairVegaPreviewService | undefined;
    setReady(false);
    setStatus("Connecting preview");
    void (async () => {
      const identity = {
        workspaceId: "altair",
        projectId: state.id,
        editorSessionId: crypto.randomUUID(),
        runtimeInstanceId: crypto.randomUUID(),
      };
      const host = studioPreviewPluginHost(),
        plan = createStudioPreviewPluginPlan(
          { plugins: JSON.parse(pluginSignature) },
          STUDIO_PLUGIN_CATALOG,
          STUDIO_PLUGIN_ENVIRONMENT,
          "bundled",
          Boolean(host),
        );
      const plugins = await loadStudioPreviewPlugins(plan, "bundled", identity, host, controller.signal);
      controller.signal.throwIfAborted();
      service = createAltairVegaPreviewService({
        ...plugins,
        officialPlugins: [...plugins.officialPlugins, session.resourcePlugin],
        theme: plan.theme ?? "haneoka",
        renderBackend: plan.renderBackend ?? "three",
      });
      service.registerMount("editor", mount.current!);
      const preview = await service.createPreview({
        identity,
        options: { mountId: "editor", autoSync: false },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await preview.dispose();
        return;
      }
      bridge.current.connectSession(preview);
      setReady(true);
      setStatus("Preview ready");
    })().catch((error) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      controller.abort();
      bridge.current.close();
      void service?.dispose();
    };
  }, [state.id, revision, pluginSignature, projectReady]);
  useEffect(() => {
    if (!ready || !state.compilation) return;
    const controller = new AbortController();
    const compilation = state.compilation;
    void bridge.current
      .syncScene(
        compilation.sceneId,
        JSON.stringify(compilation.story),
        compilation.story,
        session.runtimeIndex(),
        controller.signal,
      )
      .then(() => {
        if (!controller.signal.aborted) setStatus("Preview synchronized");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus(String(error));
      });
    return () => controller.abort();
  }, [ready, state.compilation, session]);
  const run = (operation: (bridge: StudioPreviewBridge) => Promise<void>) =>
    void operation(bridge.current).catch((error) => setStatus(String(error)));
  return (
    <section className="editor-preview">
      <div className="panel-heading">
        <span>{tr("Live preview")}</span>
        <button
          title={tr("Refresh preview")}
          aria-label={tr("Refresh preview")}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RotateCcw size={14} />
        </button>
        <button
          title={tr("Fullscreen preview")}
          aria-label={tr("Fullscreen preview")}
          onClick={() => void mount.current?.requestFullscreen()}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="preview-stage" ref={mount} />
      <div className="preview-toolbar">
        <button disabled={!ready} onClick={() => run((b) => b.runScene(0))} title={tr("Run from the beginning")}>
          <Play size={14} />
        </button>
        <button disabled={!ready} onClick={() => run((b) => b.runFrom(session.runtimeIndex()))}>
          <StepForward size={14} />
          {tr("Run from current statement")}
        </button>
        <button disabled={!ready} onClick={() => run((b) => b.pause())} title={tr("Pause")}>
          <Pause size={14} />
        </button>
        <span title={state.error || tr(status)}>
          {state.error ? tr("Preview shows the last valid version") : state.compiling ? tr("Compiling") : tr(status)}
        </span>
      </div>
    </section>
  );
}
