import { createCubismPlugin, type CubismRuntimeAdapter } from "@haneoka/vega-plugin-cubism";
import { runtimeLibraries } from "./editor/runtimes";
export function createStudioCubismPlugin() {
  let adapter: CubismRuntimeAdapter | undefined;
  let loading: Promise<CubismRuntimeAdapter> | undefined;
  const ready = (): Promise<CubismRuntimeAdapter> => {
    if (adapter) return Promise.resolve(adapter);
    return (loading ??= (async () => {
      const { createCubismWebRuntimeAdapter } = await import("@haneoka/vega-plugin-cubism/web-runtime");
      adapter = createCubismWebRuntimeAdapter({ runtime: await runtimeLibraries.sources() });
      return adapter;
    })().finally(() => {
      loading = undefined;
    }));
  };
  return createCubismPlugin({
    adapter: {
      id: "studio.cubism",
      async prepare(version, signal) {
        try {
          await (await ready()).prepare?.(version, signal);
        } catch (error) {
          if (!signal.aborted) adapter = undefined;
          throw error;
        }
      },
      async create(context) {
        return (await ready()).create(context);
      },
      async createForRenderer(context) {
        return (await ready()).createForRenderer!(context);
      },
      disposeRendererModel(model) {
        const owned = model as { release?: () => void; dispose?: () => void };
        if (owned.release) owned.release();
        else owned.dispose?.();
      },
      getMouthParameterProfile(context) {
        return adapter?.getMouthParameterProfile?.(context) ?? null;
      },
    },
  });
}
