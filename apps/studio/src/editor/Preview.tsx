import { RuntimeDebugger } from "./RuntimeDebugger";
import { VideoExport } from "./VideoExport";
import { tr } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw, StepForward, Maximize2, ExternalLink } from "@haneoka/altair-ui-react";
import { createAltairVegaPreviewService, type AltairVegaPreviewService } from "@haneoka/altair-plugin-vega-preview";
import { StudioPreviewBridge } from "../preview-bridge";
import { createStudioPreviewPluginPlan, loadStudioPreviewPlugins, studioPreviewPluginHost } from "../preview-plugins";
import {
  DEFAULT_STUDIO_PROJECT_PLUGINS,
  STUDIO_PLUGIN_CATALOG,
  STUDIO_PLUGIN_ENVIRONMENT,
} from "../studio-plugin-catalog";
import type { EditorSession } from "./session";
import { StageTransformEditor } from "./StageTransformEditor";
import { AnimationAudition } from "./animation-audition";
import { AnimationAuditionControls } from "./AnimationAuditionControls";
import type { VegaPreviewBreakpoint } from "@haneoka/altair-preview-client";
import { storyCommandAtoms } from "@haneoka/altair-plugin-vega-preview/projection";
import { VEGA_ADV_OPCODE, VEGA_SYSTEM_OPCODE } from "@haneoka/vega-protocol";
import { createPortal } from "react-dom";
import { Bug } from "@haneoka/altair-ui-react";
import { TaskSheet } from "./authoring/TaskSheet";
export function Preview({
  session,
  compact = false,
  surfaceOnly = false,
  toolsMount,
}: {
  session: EditorSession;
  compact?: boolean;
  surfaceOnly?: boolean;
  toolsMount?: HTMLElement | null;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const pluginSignature = JSON.stringify(state.project?.plugins ?? DEFAULT_STUDIO_PROJECT_PLUGINS);
  const projectReady = Boolean(state.project);
  const mount = useRef<HTMLDivElement>(null),
    bridge = useRef(new StudioPreviewBridge());
  const audition = useRef<AnimationAudition | undefined>(undefined);
  const restoreWindow = useRef<(() => void) | undefined>(undefined);
  const [detached, setDetached] = useState(false);
  useLayoutEffect(() => () => restoreWindow.current?.(), []);
  const restoredBreakpoints = useRef<readonly VegaPreviewBreakpoint[] | undefined>(undefined);
  const [status, setStatus] = useState("Connecting preview"),
    [ready, setReady] = useState(false),
    [synchronized, setSynchronized] = useState(false),
    [editingTransform, setEditingTransform] = useState(false),
    [revision, setRevision] = useState(0);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const fail = (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (error instanceof Error && error.name === "AbortError") return;
    const detail = error instanceof Error ? error.message : String(error);
    const message = /^Scene boundary \d+ is not prepared on the selected decision path$/.test(detail)
      ? "Choose a branch before previewing this statement"
      : tr(detail);
    setPreviewError(true);
    setStatus(
      message.includes("404") && message.includes(new URL("assets/", document.baseURI).href)
        ? "Reload editor"
        : message,
    );
  };
  useEffect(() => {
    if (!projectReady || session.lifetimeSignal.aborted) {
      setReady(false);
      setSynchronized(false);
      return;
    }
    const controller = new AbortController();
    const closeSession = () => {
      controller.abort();
      setReady(false);
      setSynchronized(false);
    };
    session.lifetimeSignal.addEventListener("abort", closeSession, { once: true });
    let service: AltairVegaPreviewService | undefined;
    let unsubscribe: (() => void) | undefined;
    let unregisterAudition: (() => void) | undefined;
    setReady(false);
    setSynchronized(false);
    setPreviewError(false);
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
        externalPlaybackControls: surfaceOnly,
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
      // The newly created owned runtime starts with an empty breakpoint configuration.
      bridge.current.connectSession(preview, [], identity);
      const owner = new AnimationAudition(session, bridge.current, mount.current!, controller.signal, (breakpoints) => {
        restoredBreakpoints.current = breakpoints;
        bridge.current.close();
        setRevision((value) => value + 1);
      });
      audition.current = owner;
      unregisterAudition = session.registerAnimationAudition(owner);
      unsubscribe = bridge.current.onEvent((event) => {
        if (controller.signal.aborted) return;
        if (event.event === "runtime.diagnostic" && event.level === "error") fail(event.message);
        if (event.event === "runtime.state") {
          const snapshot = event.snapshot as { commandIndex?: number; execution?: { playing?: boolean } };
          const previous = session.getSnapshot().preview;
          session.setPreviewState({
            ready: previous?.ready ?? false,
            playing: Boolean(snapshot.execution?.playing),
            commandIndex: snapshot.commandIndex ?? previous?.commandIndex ?? 0,
            status: previous?.status ?? "",
          });
        } else if (event.event === "runtime.stopped") {
          const previous = session.getSnapshot().preview;
          session.setPreviewState({
            ready: previous?.ready ?? false,
            playing: false,
            commandIndex: event.commandIndex,
            status: previous?.status ?? "",
          });
        }
      });
      setReady(true);
      setStatus("Preview ready");
    })().catch((error) => {
      if (!controller.signal.aborted) fail(error);
    });
    return () => {
      session.lifetimeSignal.removeEventListener("abort", closeSession);
      controller.abort();
      unregisterAudition?.();
      audition.current?.dispose();
      audition.current = undefined;
      unsubscribe?.();
      bridge.current.close();
      void service?.dispose();
    };
  }, [state.id, revision, pluginSignature, projectReady]);
  useEffect(() => {
    if (!ready || !state.compilation) return;
    const controller = new AbortController();
    setSynchronized(false);
    const compilation = state.compilation;
    const commandIndex = session.runtimeIndex();
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(compilation.story)))
      .then((digest) => {
        if (controller.signal.aborted) return false;
        const revision = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return bridge.current.syncScene(compilation.sceneId, revision, compilation.story, 0, controller.signal);
      })
      .then(async (executed) => {
        if (!controller.signal.aborted && executed) {
          const breakpoints = restoredBreakpoints.current;
          if (breakpoints) {
            await bridge.current.setBreakpoints(breakpoints, controller.signal);
            if (controller.signal.aborted) return;
            restoredBreakpoints.current = undefined;
          }
          if (commandIndex !== 0) await bridge.current.seek(commandIndex, controller.signal);
          if (!controller.signal.aborted) {
            setSynchronized(true);
            setPreviewError(false);
            setStatus("Preview synchronized");
          }
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) fail(error);
      });
    return () => controller.abort();
  }, [ready, state.compilation, session]);
  useEffect(() => {
    if (!ready || !synchronized || !state.compilation || !state.project || state.compiling) return;
    const snapshot = state,
      compilation = state.compilation;
    return session.registerFrameCapture(async (commandId, signal) => {
      if (session.getSnapshot().compilation !== compilation || audition.current?.getSnapshot().owned)
        throw new Error(tr("Preview is busy"));
      const scene = snapshot.project!.scenes.find((scene) => scene.id === compilation.sceneId);
      const sourceIndex = scene?.commands.findIndex((command) => command.id === commandId) ?? -1;
      const mapping = [...compilation.commandMappings]
        .reverse()
        .find((mapping) => mapping.sceneId === scene?.id && mapping.sourceCommandIndex === sourceIndex);
      if (!mapping) throw new Error(tr("Missing statement"));
      const command = scene!.commands[sourceIndex]!;
      const afterDialogue = storyCommandAtoms([command]).some((atom) => atom.command === VEGA_ADV_OPCODE.Talk);
      await bridge.current.pause(signal);
      await bridge.current.seek(mapping.commandIndex + (afterDialogue ? 1 : 0), signal);
      return bridge.current.captureStage(signal);
    });
  }, [ready, synchronized, state.compilation, state.project, state.compiling, session]);
  useEffect(() => {
    audition.current?.setReady(ready && synchronized && !editingTransform && !state.compiling && !state.error);
  }, [ready, synchronized, editingTransform, state.compiling, state.error]);
  const auditionOwned = Boolean(state.animationAudition?.owned);
  useEffect(() => {
    const previous = session.getSnapshot().preview;
    session.setPreviewState({
      ready: ready && synchronized && !state.compiling && !state.error && !auditionOwned,
      playing: previous?.playing ?? false,
      commandIndex: previous?.commandIndex ?? 0,
      status: tr(status),
    });
  }, [session, ready, synchronized, state.compiling, state.error, auditionOwned, status]);
  useEffect(() => {
    if (!ready || !synchronized || !state.compilation || auditionOwned) return;
    const controller = new AbortController();
    const seek = async (id: string, play: boolean) => {
      const source = state.project?.scenes.find((scene) => scene.id === state.compilation!.sceneId);
      const sourceIndex = source?.commands.findIndex((command) => command.id === id) ?? -1;
      const mapping = state.compilation!.commandMappings.find(
        (mapping) => mapping.sceneId === source?.id && mapping.sourceCommandIndex === sourceIndex,
      );
      if (!mapping) return;
      if (play) await bridge.current.runFrom(mapping.commandIndex, controller.signal);
      else {
        await bridge.current.pause(controller.signal);
        const command = source!.commands[sourceIndex]!;
        const interactive = new Set<number>([
          VEGA_ADV_OPCODE.ChoiceShow,
          VEGA_ADV_OPCODE.GoTo,
          VEGA_ADV_OPCODE.Wait,
          VEGA_SYSTEM_OPCODE.Input,
          VEGA_SYSTEM_OPCODE.Branch,
          VEGA_SYSTEM_OPCODE.JumpScene,
          VEGA_SYSTEM_OPCODE.CallScene,
          VEGA_SYSTEM_OPCODE.ReturnScene,
          VEGA_SYSTEM_OPCODE.End,
        ]);
        const beforeControl = storyCommandAtoms([command]).some(
          (atom) => typeof atom.command === "number" && interactive.has(atom.command),
        );
        await bridge.current.seek(mapping.commandIndex + (beforeControl ? 0 : 1), controller.signal);
      }
    };
    const navigate = async (operation: () => Promise<void>) => {
      try {
        await operation();
        if (!controller.signal.aborted) {
          setPreviewError(false);
          setStatus("Preview synchronized");
        }
      } catch (error) {
        if (!controller.signal.aborted) fail(error);
      }
    };
    const unregister = session.registerPreviewNavigation({
      seek: (id, play) => navigate(() => seek(id, play)),
      seekIndex: (index) =>
        navigate(async () => {
          await bridge.current.pause(controller.signal);
          await bridge.current.seek(index, controller.signal);
        }),
      play: () => navigate(() => bridge.current.play(controller.signal)),
      start: () => navigate(() => bridge.current.runScene(0, controller.signal)),
      stop: () => navigate(() => bridge.current.pause(controller.signal)),
    });
    if (state.selectedNodeId) void navigate(() => seek(state.selectedNodeId!, false));
    return () => {
      controller.abort();
      unregister();
    };
  }, [session, ready, synchronized, state.compilation, state.project, auditionOwned]);
  const detach = () => {
    if (restoreWindow.current) {
      restoreWindow.current();
      return;
    }
    const stage = mount.current;
    if (!stage) return;
    const preview = window.open("", "_blank", "popup,width=1100,height=700");
    if (!preview) {
      setStatus("Preview window was blocked");
      return;
    }
    const anchor = document.createComment("preview-stage");
    stage.before(anchor);
    const target = preview.document;
    target.title = state.name;
    target.documentElement.lang = document.documentElement.lang;
    const base = target.createElement("base");
    base.href = document.baseURI;
    target.head.append(base);
    for (const node of document.querySelectorAll('link[rel="stylesheet"],style'))
      target.head.append(node.cloneNode(true));
    for (const sheet of document.adoptedStyleSheets) {
      const style = target.createElement("style");
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      target.head.append(style);
    }
    for (const face of document.fonts) target.fonts.add(face);
    Object.assign(target.body.style, { margin: "0", height: "100dvh", overflow: "hidden" });
    const original = stage.getAttribute("style");
    Object.assign(stage.style, { width: "100%", height: "100%", maxHeight: "none", aspectRatio: "auto" });
    target.body.append(stage);
    const theme = () => {
      target.documentElement.className = document.documentElement.className;
      target.documentElement.style.cssText = document.documentElement.style.cssText;
      target.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "";
    };
    theme();
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const restore = () => {
      observer.disconnect();
      preview.removeEventListener("pagehide", restore);
      anchor.replaceWith(stage);
      if (original === null) stage.removeAttribute("style");
      else stage.setAttribute("style", original);
      restoreWindow.current = undefined;
      setDetached(false);
      if (!preview.closed) preview.close();
    };
    restoreWindow.current = restore;
    preview.addEventListener("pagehide", restore, { once: true });
    setDetached(true);
  };
  useEffect(() => {
    if (editingTransform || auditionOwned) restoreWindow.current?.();
  }, [editingTransform, auditionOwned]);
  const run = (operation: (bridge: StudioPreviewBridge) => Promise<void>) => void operation(bridge.current).catch(fail);
  if (surfaceOnly)
    return (
      <>
        <div className="author-native-preview">
          <div className="preview-stage" ref={mount} inert={auditionOwned} />
          <span
            className="author-preview-state"
            role="status"
            hidden={ready && synchronized && !state.error && !previewError}
          >
            {state.error ? tr("Preview shows the last valid version") : tr(status)}
          </span>
        </div>
        {toolsMount &&
          createPortal(
            <>
              <VideoExport
                bridge={bridge.current}
                ready={ready && synchronized && !state.compiling && !auditionOwned}
                onError={fail}
              />
              <button
                className="author-icon-button"
                aria-label={tr("Refresh preview")}
                title={tr("Refresh preview")}
                disabled={editingTransform || auditionOwned}
                onClick={() => setRevision((value) => value + 1)}
              >
                <RotateCcw aria-hidden />
              </button>
              <button
                className="author-icon-button"
                aria-label={tr(detached ? "Dock preview" : "Detach preview")}
                title={tr(detached ? "Dock preview" : "Detach preview")}
                disabled={!ready || editingTransform || auditionOwned}
                onClick={detach}
              >
                <ExternalLink aria-hidden />
              </button>
              <button
                className="author-icon-button"
                aria-label={tr("Fullscreen preview")}
                title={tr("Fullscreen preview")}
                onClick={() => void mount.current?.requestFullscreen().catch(fail)}
              >
                <Maximize2 aria-hidden />
              </button>
              <button
                className="author-icon-button"
                aria-label={tr("Preview debugger")}
                title={tr("Preview debugger")}
                onClick={() => setDebuggerOpen(true)}
              >
                <Bug aria-hidden />
              </button>
              <StageTransformEditor
                session={session}
                bridge={bridge.current}
                ready={ready && synchronized && !auditionOwned}
                onEditingChange={setEditingTransform}
              />
              <AnimationAuditionControls session={session} />
              {debuggerOpen && (
                <TaskSheet title={tr("Preview debugger")} wide onClose={() => setDebuggerOpen(false)}>
                  <RuntimeDebugger
                    bridge={bridge.current}
                    session={session}
                    ready={ready && synchronized && !auditionOwned}
                    expanded
                  />
                </TaskSheet>
              )}
            </>,
            toolsMount,
          )}
      </>
    );
  return (
    <section className="editor-preview">
      <div className="panel-heading">
        <span>{tr("Live preview")}</span>
        <button
          disabled={editingTransform || auditionOwned}
          title={tr("Refresh preview")}
          aria-label={tr("Refresh preview")}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RotateCcw size={14} />
        </button>
        <button
          disabled={!ready || editingTransform || auditionOwned}
          title={tr(detached ? "Dock preview" : "Detach preview")}
          aria-label={tr(detached ? "Dock preview" : "Detach preview")}
          onClick={detach}
        >
          <ExternalLink size={14} />
        </button>
        <button
          title={tr("Fullscreen preview")}
          aria-label={tr("Fullscreen preview")}
          onClick={() =>
            void (document.fullscreenElement ? document.exitFullscreen() : mount.current?.requestFullscreen())?.catch(
              () => setStatus("Fullscreen unavailable"),
            )
          }
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="preview-stage" ref={mount} inert={auditionOwned} />
      <div className="preview-toolbar">
        {!compact && (
          <VideoExport
            bridge={bridge.current}
            ready={ready && synchronized && !state.compiling && !auditionOwned}
            onError={fail}
          />
        )}
        <button
          disabled={!ready || !synchronized || state.compiling || editingTransform || auditionOwned}
          onClick={() => run((b) => b.play())}
          aria-label={tr("Play")}
          title={tr("Play")}
        >
          <Play size={14} />
        </button>
        <button
          disabled={!ready || !synchronized || state.compiling || editingTransform || auditionOwned}
          onClick={() => run((b) => b.runScene(0))}
          aria-label={tr("Run from the beginning")}
          title={tr("Run from the beginning")}
        >
          <RotateCcw size={14} />
        </button>
        {!compact && (
          <button
            disabled={!ready || !synchronized || state.compiling || editingTransform || auditionOwned}
            aria-label={tr("Run from current statement")}
            title={tr("Run from current statement")}
            onClick={() => run((b) => b.runFrom(session.runtimeIndex()))}
          >
            <StepForward size={14} />
          </button>
        )}
        <button
          disabled={!ready || editingTransform || auditionOwned}
          onClick={() => run((b) => b.pause())}
          aria-label={tr("Pause")}
          title={tr("Pause")}
        >
          <Pause size={14} />
        </button>
        {status === "Reload editor" ? (
          <button
            onClick={() =>
              void session
                .prepareReload()
                .then(() => window.location.reload())
                .catch(fail)
            }
          >
            {tr("Reload editor")}
          </button>
        ) : (
          <span title={state.error || tr(status)}>
            {state.error ? tr("Preview shows the last valid version") : state.compiling ? tr("Compiling") : tr(status)}
          </span>
        )}
      </div>
      {!compact && (
        <>
          <RuntimeDebugger bridge={bridge.current} session={session} ready={ready && synchronized && !auditionOwned} />
          <AnimationAuditionControls session={session} />
          <StageTransformEditor
            session={session}
            bridge={bridge.current}
            ready={ready && synchronized && !auditionOwned}
            onEditingChange={setEditingTransform}
          />
        </>
      )}
    </section>
  );
}
