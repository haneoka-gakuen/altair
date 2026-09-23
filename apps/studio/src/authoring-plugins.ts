import {
  AltairPluginHost,
  type AltairPlugin,
  type JsonObject,
  type StoryDiagnostic,
  type StoryProjectPlugin,
} from "@haneoka/altair";
import {
  altairPluginAuthoringExtension,
  createAltairPluginLock,
  type AltairPluginCatalog,
  type AltairPluginCatalogEntry,
  type AltairPluginTargetEnvironment,
} from "@haneoka/altair-plugin-marketplace";

export interface StudioBuiltinAuthoringPlugin {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
  };
  load(): Promise<AltairPlugin>;
}

export interface StudioAuthoringPluginReceipt {
  readonly id: string;
  readonly version: string;
}

export interface StudioAuthoringPluginHostRequest {
  readonly requested: readonly {
    readonly id: string;
    readonly version: string;
    readonly configuration?: JsonObject;
    readonly permissions: readonly string[];
    readonly source: AltairPluginCatalogEntry["source"];
  }[];
  readonly signal: AbortSignal;
}

export interface StudioAuthoringPluginHostResult {
  /**
   * In-process modules or RPC-backed proxy modules. A receipt alone cannot
   * contribute authoring behavior and is therefore never accepted.
   */
  readonly plugins: readonly AltairPlugin[];
}

export interface StudioAuthoringPluginBroker {
  load(request: StudioAuthoringPluginHostRequest): Promise<StudioAuthoringPluginHostResult>;
}

declare global {
  interface Window {
    /**
     * Desktop hosts may return exact authoring modules from an isolated,
     * trusted extension broker. Catalog JSON is never evaluated as code.
     */
    __ALTAIR_AUTHORING_PLUGIN_HOST__?: StudioAuthoringPluginBroker;
  }
}

export interface StudioAuthoringPluginPlan {
  readonly builtins: readonly StudioPlannedAuthoringPlugin[];
  readonly hostEntries: StudioAuthoringPluginHostRequest["requested"];
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly key: string;
}

export interface StudioPlannedAuthoringPlugin extends StudioBuiltinAuthoringPlugin {
  readonly configuration?: JsonObject;
  readonly permissions: readonly string[];
}

export interface LoadedStudioAuthoringPlugins {
  readonly host: AltairPluginHost;
  readonly loaded: readonly StudioAuthoringPluginReceipt[];
  dispose(): Promise<void>;
}

const builtin = (id: string, version: string, load: () => Promise<AltairPlugin>): StudioBuiltinAuthoringPlugin =>
  Object.freeze({
    manifest: Object.freeze({ id, version }),
    load,
  });

const builtins = new Map<string, StudioBuiltinAuthoringPlugin>(
  [
    builtin("haneoka.altair-models", "0.1.0", async () => {
      const { altairModelsPlugin } = await import("@haneoka/altair-plugin-models");
      return altairModelsPlugin;
    }),
    builtin("haneoka.altair-adv", "0.1.0", async () => {
      const { altairAdvPlugin } = await import("@haneoka/altair-plugin-adv");
      return altairAdvPlugin;
    }),
    builtin("haneoka.altair-flow", "0.1.0", async () => {
      const { altairFlowPlugin } = await import("@haneoka/altair-plugin-flow");
      return altairFlowPlugin;
    }),
    builtin("haneoka.altair-history", "0.1.0", async () => {
      const { altairHistoryPlugin } = await import("@haneoka/altair-plugin-history");
      return altairHistoryPlugin;
    }),
    builtin("haneoka.altair-drafts", "0.1.0", async () => {
      const { altairDraftsPlugin, createAltairDraftsPlugin, createAltairIndexedDbDraftPersistence } =
        await import("@haneoka/altair-plugin-drafts");
      return typeof globalThis.indexedDB === "undefined"
        ? altairDraftsPlugin
        : createAltairDraftsPlugin({
            persistenceFactory: () =>
              createAltairIndexedDbDraftPersistence({
                databaseName: "haneoka-altair-studio",
              }),
          });
    }),
    builtin("haneoka.altair-marketplace", "0.1.0", async () => {
      const { altairMarketplacePlugin } = await import("@haneoka/altair-plugin-marketplace");
      return altairMarketplacePlugin;
    }),
    builtin("haneoka.altair-prose", "0.1.0", async () => {
      const { altairProsePlugin } = await import("@haneoka/altair-plugin-prose");
      return altairProsePlugin;
    }),
    builtin("haneoka.altair-vega-preview", "0.1.0", async () => {
      const { altairVegaPreviewPlugin } = await import("@haneoka/altair-plugin-vega-preview");
      return altairVegaPreviewPlugin;
    }),
    builtin("haneoka.altair-webgal", "0.1.0", async () => {
      const { altairWebGalPlugin } = await import("@haneoka/altair-plugin-webgal");
      return altairWebGalPlugin;
    }),
    builtin("haneoka.altair-workspace-browser", "0.1.0", async () => {
      const { altairWorkspaceBrowserPlugin } = await import("@haneoka/altair-plugin-workspace-browser");
      return altairWorkspaceBrowserPlugin;
    }),
  ].map((entry) => [entry.manifest.id, entry]),
);

export const hasStudioBuiltinAuthoringPlugin = (id: string, version: string): boolean =>
  builtins.get(id)?.manifest.version === version;

const diagnostic = (
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
  plugins: readonly StoryProjectPlugin[],
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
  brokerAvailable: boolean,
): string => {
  const value = JSON.stringify({
    plugins: plugins
      .filter(({ enabled }) => enabled !== false)
      .map(({ id, version, permissions, configuration }) => ({
        id,
        version,
        permissions,
        configuration,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    catalog,
    environment,
    brokerAvailable,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `authoring-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const createStudioAuthoringPluginPlan = (
  plugins: readonly StoryProjectPlugin[],
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
  brokerAvailable: boolean,
): StudioAuthoringPluginPlan => {
  const resolution = createAltairPluginLock(
    { plugins: plugins.map((plugin) => ({ ...plugin })) },
    catalog,
    environment,
  );
  const diagnostics = resolution.diagnostics.map((entry) =>
    diagnostic(entry.severity, `studio.authoring.plugin.${entry.code}`, entry.pluginId, entry.message),
  );
  const installed = new Map(plugins.map((entry) => [entry.id, entry]));
  const authoringEntries = resolution.entries.filter(
    (entry) => altairPluginAuthoringExtension(catalog, entry)?.scope === "authoring",
  );
  const authoringPluginIds = new Set(authoringEntries.map(({ id }) => id));
  const selectedBuiltins: StudioPlannedAuthoringPlugin[] = [];
  const hostEntries: Array<StudioAuthoringPluginHostRequest["requested"][number]> = [];
  for (const entry of authoringEntries) {
    const projectPlugin = installed.get(entry.id);
    if (!projectPlugin || projectPlugin.enabled === false) continue;
    const extension = altairPluginAuthoringExtension(catalog, entry);
    const requiredPermissions = extension?.permissions ?? [];
    const missing = requiredPermissions.filter((permission) => !projectPlugin.permissions?.includes(permission));
    if (missing.length) {
      diagnostics.push(
        diagnostic(
          "error",
          "studio.authoring.plugin.permissions-ungranted",
          entry.id,
          `Authoring plugin ${entry.id} requires permission review: ${missing.join(", ")}`,
        ),
      );
      continue;
    }
    const trusted = builtins.get(entry.id);
    if (trusted) {
      if (trusted.manifest.version !== entry.version) {
        diagnostics.push(
          diagnostic(
            "error",
            "studio.authoring.plugin.builtin-version",
            entry.id,
            `Bundled ${entry.id}@${trusted.manifest.version} does not match ${entry.id}@${entry.version}`,
          ),
        );
      } else {
        selectedBuiltins.push(
          Object.freeze({
            ...trusted,
            ...(projectPlugin.configuration === undefined ? {} : { configuration: projectPlugin.configuration }),
            permissions: Object.freeze([...(projectPlugin.permissions ?? [])]),
          }),
        );
      }
      continue;
    }
    hostEntries.push({
      id: entry.id,
      version: entry.version,
      ...(projectPlugin.configuration === undefined ? {} : { configuration: projectPlugin.configuration }),
      permissions: Object.freeze([...(projectPlugin.permissions ?? [])]),
      source: entry.source,
    });
  }
  if (hostEntries.length && !brokerAvailable) {
    diagnostics.push(
      diagnostic(
        "error",
        "studio.authoring.plugin.host-unavailable",
        hostEntries[0]!.id,
        `No trusted authoring plugin host provided ${hostEntries
          .map(({ id, version }) => `${id}@${version}`)
          .join(", ")}`,
      ),
    );
  }
  return Object.freeze({
    builtins: Object.freeze(selectedBuiltins),
    hostEntries: Object.freeze(brokerAvailable ? hostEntries : []),
    diagnostics: Object.freeze(diagnostics),
    key: stableKey(
      plugins.filter(({ id }) => authoringPluginIds.has(id)),
      catalog,
      environment,
      brokerAvailable,
    ),
  });
};

export const studioAuthoringPluginBroker = (): StudioAuthoringPluginBroker | undefined =>
  window.__ALTAIR_AUTHORING_PLUGIN_HOST__;

export const loadStudioAuthoringPlugins = async (
  plan: StudioAuthoringPluginPlan,
  broker: StudioAuthoringPluginBroker | undefined,
  signal: AbortSignal,
): Promise<LoadedStudioAuthoringPlugins> => {
  const host = new AltairPluginHost();
  const loaded: StudioAuthoringPluginReceipt[] = [];
  try {
    for (const descriptor of plan.builtins) {
      signal.throwIfAborted();
      const plugin = await descriptor.load();
      assertIdentity(plugin, descriptor.manifest);
      await host.install(plugin, {
        ...(descriptor.configuration === undefined ? {} : { configuration: descriptor.configuration }),
        permissions: descriptor.permissions,
      });
      loaded.push(descriptor.manifest);
    }
    if (plan.hostEntries.length) {
      if (!broker) throw new Error("Authoring plugin host is unavailable");
      const result = await broker.load({
        requested: plan.hostEntries,
        signal,
      });
      signal.throwIfAborted();
      const plugins = [...result.plugins];
      assertExactPlugins(plan.hostEntries, plugins);
      for (const plugin of plugins) {
        const activation = plan.hostEntries.find(({ id }) => id === plugin.manifest.id)!;
        await host.install(plugin, {
          ...(activation.configuration === undefined ? {} : { configuration: activation.configuration }),
          permissions: activation.permissions,
        });
        loaded.push({
          id: plugin.manifest.id,
          version: plugin.manifest.version,
        });
      }
    }
    return Object.freeze({
      host,
      loaded: Object.freeze(loaded),
      dispose: () => host.dispose(),
    });
  } catch (error) {
    await host.dispose().catch(() => undefined);
    throw error;
  }
};

/**
 * Rebuilds on every exact activation change. Configuration, grants, source,
 * integrity, environment and version therefore cannot remain stale.
 */
export const reconcileStudioAuthoringPlugins = async (
  _current: LoadedStudioAuthoringPlugins,
  plan: StudioAuthoringPluginPlan,
  broker: StudioAuthoringPluginBroker | undefined,
  signal: AbortSignal,
): Promise<LoadedStudioAuthoringPlugins> => {
  const next = await loadStudioAuthoringPlugins(plan, broker, signal);
  try {
    signal.throwIfAborted();
    return next;
  } catch (error) {
    await next.dispose().catch(() => undefined);
    throw error;
  }
};

const identity = (value: StudioAuthoringPluginReceipt): string => `${value.id}@${value.version}`;

const assertIdentity = (plugin: AltairPlugin, expected: StudioAuthoringPluginReceipt): void => {
  if (plugin.manifest.id !== expected.id || plugin.manifest.version !== expected.version) {
    throw new TypeError(`Authoring plugin loaded ${identity(plugin.manifest)}, expected ${identity(expected)}`);
  }
};

const assertExactPlugins = (
  expected: StudioAuthoringPluginHostRequest["requested"],
  plugins: readonly AltairPlugin[],
): void => {
  const expectedKeys = new Set(expected.map(identity));
  const actualKeys = new Set<string>();
  for (const plugin of plugins) {
    const key = identity(plugin.manifest);
    if (!expectedKeys.has(key) || actualKeys.has(key)) {
      throw new TypeError(`Unexpected authoring plugin module ${key}`);
    }
    actualKeys.add(key);
  }
  if (actualKeys.size !== expectedKeys.size) {
    throw new TypeError("Authoring plugin host omitted a requested module");
  }
};
