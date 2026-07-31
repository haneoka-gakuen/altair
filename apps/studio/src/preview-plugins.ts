import {
  type StoryDiagnostic,
  type StoryProject,
} from "@haneoka/altair";
import {
  altairPluginAuthoringExtension,
  createAltairPluginLock,
  type AltairPluginCatalog,
  type AltairPluginLock,
  type AltairPluginTargetEnvironment,
} from "@haneoka/altair-plugin-marketplace";
import type { VegaPlugin } from "@haneoka/vega/engine";
import type { VegaPreviewIdentity } from "@haneoka/altair-preview-client";

type LockedPlugin = AltairPluginLock["plugins"][number];
const PORTABLE_UI_PLUGIN_ID = "haneoka.vega-portable-ui";
const PORTABLE_UI_PLUGIN_VERSION = "0.1.0";
const RICH_TEXT_PLUGIN_ID = "haneoka.vega-richtext";
const RICH_TEXT_PLUGIN_VERSION = "0.1.0";

export type StudioPreviewPluginDestination = "bundled" | "brokered";

export interface StudioPreviewPluginReceipt {
  readonly id: string;
  readonly version: string;
}

export interface StudioPreviewPluginHostRequest {
  readonly destination: StudioPreviewPluginDestination;
  /** Complete canonical lock; loaders must provision exactly this selection. */
  readonly lock: AltairPluginLock;
  /** Entries without an implementation in Studio's trusted built-in registry. */
  readonly requested: readonly LockedPlugin[];
  readonly identity: VegaPreviewIdentity;
  readonly signal: AbortSignal;
}

export interface StudioPreviewPluginHostResult {
  /**
   * Trusted plugin objects for the bundled runtime. Brokered runtimes keep
   * executable modules out of Studio and return only `loaded` receipts.
   */
  readonly plugins?: readonly VegaPlugin[];
  readonly loaded?: readonly StudioPreviewPluginReceipt[];
}

export interface StudioPreviewPluginHost {
  load(
    request: StudioPreviewPluginHostRequest,
  ): Promise<StudioPreviewPluginHostResult>;
}

export interface StudioPreviewPluginPlan {
  readonly destination: StudioPreviewPluginDestination;
  readonly lock: AltairPluginLock | null;
  readonly builtins: readonly StudioBuiltinPreviewPlugin[];
  readonly hostEntries: readonly LockedPlugin[];
  /** Theme selected by the trusted bundled runtime profile. */
  readonly theme?: string;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly key: string;
}

export interface LoadedStudioPreviewPlugins {
  /** Exact trusted modules shipped by this Altair distribution. */
  readonly officialPlugins: readonly VegaPlugin[];
  /** Implementations supplied by a host retain third-party authority. */
  readonly plugins: readonly VegaPlugin[];
  readonly loaded: readonly StudioPreviewPluginReceipt[];
}

declare global {
  interface Window {
    /**
     * A trusted desktop shell or isolated runtime broker may provide exact
     * plugin implementations. Studio never imports marketplace URLs itself.
     */
    __ALTAIR_VEGA_PLUGIN_HOST__?: StudioPreviewPluginHost;
  }
}

export interface StudioBuiltinPreviewPlugin {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
  };
  /** Optional theme contributed by this built-in and its selection priority. */
  readonly previewTheme?: {
    readonly id: string;
    readonly priority: number;
  };
  load(): Promise<VegaPlugin>;
}

const studioBuiltin = (
  id: string,
  version: string,
  load: () => Promise<VegaPlugin>,
  previewTheme?: StudioBuiltinPreviewPlugin["previewTheme"],
): StudioBuiltinPreviewPlugin =>
  Object.freeze({
    manifest: Object.freeze({ id, version }),
    ...(previewTheme
      ? { previewTheme: Object.freeze({ ...previewTheme }) }
      : {}),
    load,
  });

const createStudioBuiltinPlugins = (): readonly StudioBuiltinPreviewPlugin[] =>
  Object.freeze([
    studioBuiltin(
      PORTABLE_UI_PLUGIN_ID,
      PORTABLE_UI_PLUGIN_VERSION,
      async () => {
        const { vegaPortableUiPlugin } = await import(
          "@haneoka/vega-ui-portable"
        );
        return vegaPortableUiPlugin;
      },
      { id: "portable", priority: 100 },
    ),
    studioBuiltin("haneoka.renderer-pixi", "0.1.0", async () => {
      const { createPixiRendererPlugin } = await import(
        "@haneoka/vega-renderer-pixi"
      );
      return createPixiRendererPlugin();
    }),
    studioBuiltin(RICH_TEXT_PLUGIN_ID, RICH_TEXT_PLUGIN_VERSION, async () => {
      const { createVegaRichTextPlugin } = await import(
        "@haneoka/vega-plugin-richtext"
      );
      return createVegaRichTextPlugin();
    }),
    studioBuiltin("haneoka.webgal-runtime", "0.1.0", async () => {
      const { createWebGalCompatibilityPlugin } = await import(
        "@haneoka/vega-plugin-webgal"
      );
      return createWebGalCompatibilityPlugin();
    }),
    studioBuiltin(
      "haneoka.vega-shell-default",
      "0.1.0",
      async () => {
        const { vegaDefaultShell } = await import(
          "@haneoka/vega-shell-default"
        );
        return vegaDefaultShell;
      },
      { id: "default", priority: 0 },
    ),
    studioBuiltin(
      "haneoka.theme",
      "0.1.0",
      async () => {
        const { vegaHaneokaTheme } = await import(
          "@haneoka/vega-theme-haneoka"
        );
        return vegaHaneokaTheme;
      },
      { id: "haneoka", priority: 200 },
    ),
  ]);

const builtinPlugins = new Map<string, StudioBuiltinPreviewPlugin>(
  createStudioBuiltinPlugins().map((plugin) => [
    plugin.manifest.id,
    plugin,
  ]),
);

export const hasStudioBuiltinPreviewPlugin = (
  id: string,
  version: string,
): boolean => builtinPlugins.get(id)?.manifest.version === version;

const pluginDiagnostic = (
  severity: "error" | "warning",
  code: string,
  pluginId: string,
  message: string,
): StoryDiagnostic => ({
  severity,
  code,
  path: `$.plugins[${JSON.stringify(pluginId)}]`,
  message,
});

const stableKey = (
  destination: StudioPreviewPluginDestination,
  lock: AltairPluginLock | null,
): string => {
  const value = `${destination}:${JSON.stringify(lock)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `plugins-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const exactBuiltin = (
  entry: LockedPlugin,
): {
  readonly plugin?: StudioBuiltinPreviewPlugin;
  readonly diagnostic?: StoryDiagnostic;
} => {
  const plugin = builtinPlugins.get(entry.id);
  if (!plugin) return {};
  if (plugin.manifest.version !== entry.version) {
    return {
      diagnostic: pluginDiagnostic(
        "error",
        "studio.preview.plugin-builtin-version",
        entry.id,
        `Bundled ${entry.id}@${plugin.manifest.version} does not satisfy the locked ${entry.id}@${entry.version}`,
      ),
    };
  }
  return { plugin };
};

const selectBuiltinPreviewTheme = (
  plugins: readonly StudioBuiltinPreviewPlugin[],
): string | undefined =>
  plugins
    .flatMap((plugin) =>
      plugin.previewTheme ? [plugin.previewTheme] : [],
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.id.localeCompare(right.id),
    )[0]?.id;

export const createStudioPreviewPluginPlan = (
  project: Pick<StoryProject, "plugins">,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
  destination: StudioPreviewPluginDestination,
  hostAvailable: boolean,
): StudioPreviewPluginPlan => {
  const resolved = createAltairPluginLock(project, catalog, environment);
  const diagnostics: StoryDiagnostic[] = resolved.diagnostics.map(
    ({ severity, code, pluginId, message }) =>
      pluginDiagnostic(severity, `studio.preview.plugin.${code}`, pluginId, message),
  );
  for (const diagnostic of resolved.diagnostics) {
    if (diagnostic.code !== "permission-review-required") continue;
    const entry = resolved.entries.find(({ id }) => id === diagnostic.pluginId);
    if (
      !entry ||
      altairPluginAuthoringExtension(catalog, entry)?.scope === "authoring"
    ) {
      continue;
    }
    diagnostics.push(
      pluginDiagnostic(
        "error",
        "studio.preview.plugin-permissions-ungranted",
        diagnostic.pluginId,
        `Preview cannot execute ${diagnostic.pluginId} until its required permissions are explicitly granted`,
      ),
    );
  }
  const builtins: StudioBuiltinPreviewPlugin[] = [];
  const hostEntries: LockedPlugin[] = [];
  for (const entry of resolved.lock?.plugins ?? []) {
    if (destination === "bundled") {
      const builtin = exactBuiltin(entry);
      if (builtin.diagnostic) diagnostics.push(builtin.diagnostic);
      else if (builtin.plugin) builtins.push(builtin.plugin);
      else hostEntries.push(entry);
    } else {
      hostEntries.push(entry);
    }
  }
  if (hostEntries.length && !hostAvailable) {
    diagnostics.push(
      pluginDiagnostic(
        "error",
        "studio.preview.plugin-host-unavailable",
        hostEntries[0]!.id,
        `Preview cannot start because no trusted plugin host provided ${hostEntries
          .map(({ id, version }) => `${id}@${version}`)
          .join(", ")}`,
      ),
    );
  }

  /*
   * Portable UI and its Rich Text dependency are Vega's asset-free Studio
   * fallback, not marketplace installations. A locked ui-slot implementation
   * suppresses them. If a catalog exposes the fallback explicitly,
   * exactBuiltin above makes that selection lock-controlled as well.
   */
  if (
    destination === "bundled" &&
    !resolved.lock?.plugins.some(({ capabilities }) =>
      capabilities?.includes("ui-slot"),
    ) &&
    !builtins.some(
      ({ manifest }) => manifest.id === PORTABLE_UI_PLUGIN_ID,
    )
  ) {
    if (
      !builtins.some(
        ({ manifest }) => manifest.id === RICH_TEXT_PLUGIN_ID,
      )
    ) {
      builtins.push(builtinPlugins.get(RICH_TEXT_PLUGIN_ID)!);
    }
    builtins.push(builtinPlugins.get(PORTABLE_UI_PLUGIN_ID)!);
  }

  const theme =
    destination === "bundled"
      ? selectBuiltinPreviewTheme(builtins)
      : undefined;
  return {
    destination,
    lock: resolved.lock,
    builtins: Object.freeze(builtins),
    hostEntries: Object.freeze(hostEntries),
    ...(theme ? { theme } : {}),
    diagnostics: Object.freeze(diagnostics),
    key: stableKey(destination, resolved.lock),
  };
};

const receiptKey = ({ id, version }: StudioPreviewPluginReceipt): string =>
  `${id}@${version}`;

const validateExactReceipts = (
  expected: readonly LockedPlugin[],
  receipts: readonly StudioPreviewPluginReceipt[],
): void => {
  const expectedKeys = new Set(expected.map(receiptKey));
  const actualKeys = new Set<string>();
  for (const receipt of receipts) {
    const key = receiptKey(receipt);
    if (actualKeys.has(key)) {
      throw new Error(`Plugin host returned duplicate receipt ${key}`);
    }
    if (!expectedKeys.has(key)) {
      throw new Error(`Plugin host returned unlocked plugin ${key}`);
    }
    actualKeys.add(key);
  }
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  if (missing.length) {
    throw new Error(`Plugin host did not load ${missing.join(", ")}`);
  }
};

const orderPlugins = (
  plugins: readonly VegaPlugin[],
  lock: AltairPluginLock,
): readonly VegaPlugin[] => {
  const byId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
  const locked = new Map(lock.plugins.map((entry) => [entry.id, entry]));
  const ordered: VegaPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of Object.keys(locked.get(id)?.dependencies ?? {})) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    const plugin = byId.get(id);
    if (plugin) ordered.push(plugin);
  };
  for (const entry of lock.plugins) visit(entry.id);
  for (const plugin of plugins) {
    if (!visited.has(plugin.manifest.id)) ordered.push(plugin);
  }
  return Object.freeze(ordered);
};

export const loadStudioPreviewPlugins = async (
  plan: StudioPreviewPluginPlan,
  destination: StudioPreviewPluginDestination,
  identity: VegaPreviewIdentity,
  host: StudioPreviewPluginHost | undefined,
  signal: AbortSignal,
): Promise<LoadedStudioPreviewPlugins> => {
  if (plan.destination !== destination) {
    throw new Error(
      `Preview plugin plan targets ${plan.destination}, not ${destination}`,
    );
  }
  const blocking = plan.diagnostics.filter(({ severity }) => severity === "error");
  if (blocking.length || !plan.lock) {
    throw new Error(
      blocking.map(({ message }) => message).join("; ") ||
        "Preview plugin lock could not be resolved",
    );
  }
  if (signal.aborted) throw signal.reason;
  const officialPlugins = await Promise.all(
    plan.builtins.map(async (builtin) => {
      const plugin = await builtin.load();
      if (
        plugin.manifest.id !== builtin.manifest.id ||
        plugin.manifest.version !== builtin.manifest.version
      ) {
        throw new Error(
          `Bundled plugin ${builtin.manifest.id}@${builtin.manifest.version} loaded ` +
            `${plugin.manifest.id}@${plugin.manifest.version}`,
        );
      }
      return plugin;
    }),
  );
  if (signal.aborted) throw signal.reason;
  let hostPlugins: readonly VegaPlugin[] = [];
  let receipts: readonly StudioPreviewPluginReceipt[] = [];
  if (plan.hostEntries.length) {
    if (!host) throw new Error("Preview plugin host is unavailable");
    const result = await host.load({
      destination,
      lock: plan.lock,
      requested: plan.hostEntries,
      identity,
      signal,
    });
    if (signal.aborted) throw signal.reason;
    if (destination === "bundled") {
      hostPlugins = result.plugins ?? [];
      receipts = hostPlugins.map(({ manifest }) => ({
        id: manifest.id,
        version: manifest.version,
      }));
    } else {
      receipts = result.loaded ?? [];
    }
    validateExactReceipts(plan.hostEntries, receipts);
  }
  const plugins = [...officialPlugins, ...hostPlugins];
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.manifest.id)) {
      throw new Error(`Plugin host returned duplicate implementation ${plugin.manifest.id}`);
    }
    ids.add(plugin.manifest.id);
  }
  const ordered =
    destination === "bundled"
      ? orderPlugins(plugins, plan.lock)
      : Object.freeze<VegaPlugin[]>([]);
  const officialIds = new Set(
    officialPlugins.map(({ manifest }) => manifest.id),
  );
  return {
    officialPlugins: Object.freeze(
      ordered.filter(({ manifest }) => officialIds.has(manifest.id)),
    ),
    plugins: Object.freeze(
      ordered.filter(({ manifest }) => !officialIds.has(manifest.id)),
    ),
    loaded: Object.freeze([
      ...officialPlugins
        .filter(({ manifest }) =>
          plan.lock?.plugins.some(({ id }) => id === manifest.id),
        )
        .map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
      ...receipts,
    ]),
  };
};

export const studioPreviewPluginHost = (): StudioPreviewPluginHost | undefined =>
  window.__ALTAIR_VEGA_PLUGIN_HOST__;
