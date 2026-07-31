import {
  type JsonObject,
  type StoryProject,
  type StoryProjectPlugin,
} from "@haneoka/altair";
import type {
  AltairMarketplaceService,
  AltairPluginCatalog,
} from "@haneoka/altair-plugin-marketplace";
import { useEffect, useMemo, useState } from "react";
import {
  hasStudioBuiltinPreviewPlugin,
  studioPreviewPluginHost,
} from "./preview-plugins";
import { StudioIcon } from "./StudioIcon";
import { STUDIO_PLUGIN_ENVIRONMENT } from "./studio-plugin-catalog";

export interface PluginManagerProps {
  readonly catalog: AltairPluginCatalog;
  readonly project: StoryProject | null;
  readonly marketplace?: AltairMarketplaceService;
  readonly onCatalogAdd: (catalog: AltairPluginCatalog) => void;
  readonly onPluginsChange: (
    plugins: readonly StoryProjectPlugin[],
  ) => void | Promise<void>;
}

const downloadText = (value: string, filename: string): void => {
  const blob = new Blob([value], { type: "application/json" });
  const link = document.createElement("a");
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
};

const sourceLabel = (
  source: AltairPluginCatalog["plugins"][number]["source"],
): string => {
  switch (source.type) {
    case "registry":
      return `registry:${source.package}`;
    case "url":
      return `url:${source.url}`;
    case "workspace":
      return `workspace:${source.path}`;
    case "builtin":
      return `builtin:${source.key}`;
  }
};

const pluginIdentity = (entry: { readonly id: string; readonly version: string }) =>
  `${entry.id}@${entry.version}`;

const RUNTIME_LOCK_PLATFORMS = [
  "web",
  "pwa",
  "electron",
  "tauri",
  "android",
  "ios",
] as const;
type RuntimeLockPlatform = (typeof RUNTIME_LOCK_PLATFORMS)[number];

export function PluginManager({
  catalog,
  marketplace,
  project,
  onCatalogAdd,
  onPluginsChange,
}: PluginManagerProps) {
  const [query, setQuery] = useState("");
  const [selectedPluginIdentity, setSelectedPluginIdentity] = useState(
    "haneoka.altair-webgal@0.1.0",
  );
  const [remoteUrl, setRemoteUrl] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [actionError, setActionError] = useState("");
  const [configurationText, setConfigurationText] = useState("{}");
  const [runtimeLockPlatform, setRuntimeLockPlatform] =
    useState<RuntimeLockPlatform>("web");
  const results = useMemo(
    () => marketplace?.search(catalog, query) ?? [],
    [catalog, marketplace, query],
  );
  const selected =
    results.find(
      (entry) => pluginIdentity(entry) === selectedPluginIdentity,
    ) ??
    results[0] ??
    catalog.plugins.find(
      (entry) => pluginIdentity(entry) === selectedPluginIdentity,
    );
  const installed = project?.plugins?.find(
    ({ id, version }) =>
      id === selected?.id && version === selected?.version,
  );
  const selectedAuthoring = selected
    ? marketplace?.authoringExtension(catalog, selected)
    : undefined;
  const diagnostics = useMemo(
    () =>
      project
        ? marketplace?.diagnose(
            project,
            catalog,
            STUDIO_PLUGIN_ENVIRONMENT,
          ) ?? []
        : [],
    [catalog, marketplace, project],
  );
  const selectedDiagnostics = diagnostics.filter(
    ({ pluginId, relatedPluginId }) =>
      pluginId === selected?.id || relatedPluginId === selected?.id,
  );
  const selectedPreviewHostMissing =
    installed !== undefined &&
    installed?.enabled !== false &&
    selectedAuthoring?.scope !== "authoring" &&
    !hasStudioBuiltinPreviewPlugin(
      selected?.id ?? "",
      selected?.version ?? "",
    ) &&
    studioPreviewPluginHost() === undefined;
  const selectedPermissions = [
    ...(selected?.permissions ?? []),
    ...(selectedAuthoring?.permissions ?? []),
  ].filter(
    (permission, index, permissions) =>
      permissions.indexOf(permission) === index,
  );
  const selectedGrantedPermissions = selectedPermissions.filter((permission) =>
    installed?.permissions?.includes(permission),
  );
  const selectedMissingPermissions = selectedPermissions.filter(
    (permission) => !installed?.permissions?.includes(permission),
  );

  useEffect(() => {
    setConfigurationText(
      JSON.stringify(installed?.configuration ?? {}, null, 2),
    );
  }, [installed?.configuration, installed?.id]);

  const apply = (
    operation: (current: StoryProject) => StoryProject,
  ): void => {
    if (!project) return;
    setActionError("");
    try {
      const next = operation(project);
      void Promise.resolve(onPluginsChange(next.plugins ?? [])).catch((error) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!marketplace) {
    return (
      <section aria-label="Project extensions" className="plugin-manager">
        <p className="tree-empty">Enable the marketplace extension.</p>
      </section>
    );
  }

  const installSelection = (grantPermissions: boolean): void => {
    if (!selected) return;
    apply((current) => {
      const installedProject = marketplace.install(
        current,
        selected.id,
        catalog,
        {
          version: selected.version,
          environment: STUDIO_PLUGIN_ENVIRONMENT,
        },
      );
      return grantPermissions && selectedPermissions.length
        ? marketplace.setPermissions(
            installedProject,
            selected.id,
            selectedPermissions,
          )
        : installedProject;
    });
  };

  const install = (): void => installSelection(false);
  const installAndGrant = (): void => installSelection(true);

  const grantPermissions = (): void => {
    if (!selected || !installed) return;
    apply((current) =>
      marketplace.setPermissions(current, selected.id, [
        ...(installed.permissions ?? []),
        ...selectedMissingPermissions,
      ]),
    );
  };

  const revokePermissions = (): void => {
    if (!selected || !installed) return;
    apply((current) =>
      marketplace.setPermissions(
        current,
        selected.id,
        (installed.permissions ?? []).filter(
          (permission) => !selectedPermissions.includes(permission),
        ),
      ),
    );
  };

  const saveConfiguration = (): void => {
    if (!selected) return;
    let value: unknown;
    try {
      value = JSON.parse(configurationText) as unknown;
    } catch (error) {
      setActionError(
        `Configuration is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      setActionError("Configuration must be a JSON object");
      return;
    }
    apply((current) =>
      marketplace.configure(
        current,
        selected.id,
        value as JsonObject,
      ),
    );
  };

  const addRemoteCatalog = async (): Promise<void> => {
    if (!remoteUrl.trim()) return;
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const remote = await marketplace.loadCatalog({
        kind: "http",
        id: new URL(remoteUrl).hostname || "remote",
        url: remoteUrl,
      });
      onCatalogAdd(remote);
      setRemoteUrl("");
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setCatalogBusy(false);
    }
  };

  const exportLock = (): void => {
    if (!project) return;
    const result = marketplace.createLock(
      project,
      catalog,
      {
        ...STUDIO_PLUGIN_ENVIRONMENT,
        platform: runtimeLockPlatform,
      },
    );
    if (result.diagnostics.some(({ severity }) => severity === "error")) {
      setActionError("Resolve plugin errors before exporting the runtime lock.");
      return;
    }
    if (!result.lock) {
      setActionError(
        result.diagnostics.some(
          ({ code }) => code === "permission-review-required",
        )
          ? "Grant required runtime permissions before exporting the lock."
          : "The Vega runtime lock could not be resolved.",
      );
      return;
    }
    downloadText(
      marketplace.serializeLock(result.lock),
      "vega.plugins.lock.json",
    );
  };

  return (
    <section aria-label="Project extensions" className="plugin-manager">
      <div className="plugin-search-row">
        <input
          aria-label="Search extensions"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search extensions"
          type="search"
          value={query}
        />
        <select
          aria-label="Runtime lock target"
          onChange={(event) =>
            setRuntimeLockPlatform(event.target.value as RuntimeLockPlatform)
          }
          title="Runtime lock target"
          value={runtimeLockPlatform}
        >
          {RUNTIME_LOCK_PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {platform}
            </option>
          ))}
        </select>
        <button
          aria-label="Export runtime lock"
          disabled={!project}
          onClick={exportLock}
          title="Export canonical Vega runtime lock"
        >
          <StudioIcon name="download" />
        </button>
      </div>

      <div aria-label="Extension results" className="plugin-results">
        {results.map((entry) => {
          const state = project?.plugins?.find(
            ({ id, version }) =>
              id === entry.id && version === entry.version,
          );
          const authoring = marketplace.authoringExtension(catalog, entry);
          const previewHostMissing =
            state?.enabled !== false &&
            state !== undefined &&
            authoring?.scope !== "authoring" &&
            !hasStudioBuiltinPreviewPlugin(entry.id, entry.version) &&
            studioPreviewPluginHost() === undefined;
          const hasError = diagnostics.some(
            ({ pluginId, severity }) =>
              pluginId === entry.id && severity === "error",
          );
          const hasWarning = diagnostics.some(
            ({ pluginId, severity }) =>
              pluginId === entry.id && severity === "warning",
          );
          return (
            <button
              aria-current={
                pluginIdentity(selected ?? { id: "", version: "" }) ===
                pluginIdentity(entry)
                  ? "true"
                  : undefined
              }
              className={
                pluginIdentity(selected ?? { id: "", version: "" }) ===
                pluginIdentity(entry)
                  ? "plugin-result selected"
                  : "plugin-result"
              }
              key={pluginIdentity(entry)}
              onClick={() =>
                setSelectedPluginIdentity(pluginIdentity(entry))
              }
            >
              <span aria-hidden="true" className="plugin-mark">
                {entry.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <b>{entry.name}</b>
                <small>
                  {entry.id} · {entry.version}
                </small>
              </span>
              {state ? (
                <em
                  className={
                    hasError || previewHostMissing
                      ? "plugin-state error"
                      : hasWarning
                        ? "plugin-state warning"
                      : state.enabled === false
                        ? "plugin-state"
                        : "plugin-state active"
                  }
                >
                  {hasError || previewHostMissing
                    ? "Issue"
                    : hasWarning
                      ? "Review"
                    : state.enabled === false
                      ? "Off"
                      : "On"}
                </em>
              ) : null}
            </button>
          );
        })}
        {!results.length && (
          <p className="tree-empty">No matching extensions.</p>
        )}
      </div>

      {selected && (
        <div className="plugin-detail">
          <header>
            <div>
              <b>{selected.name}</b>
              <small>{selectedAuthoring?.scope ?? "runtime"}</small>
            </div>
            {!installed ? (
              <div className="plugin-install-actions">
                <button disabled={!project} onClick={install}>
                  Install
                </button>
                {selectedPermissions.length > 0 && (
                  <button
                    className="primary"
                    disabled={!project}
                    onClick={installAndGrant}
                  >
                    Install &amp; grant {selectedPermissions.length}
                  </button>
                )}
              </div>
            ) : (
              <label className="plugin-toggle">
                <input
                  checked={installed.enabled !== false}
                  disabled={installed.required}
                  onChange={(event) =>
                    apply((current) =>
                      marketplace.setEnabled(
                        current,
                        selected.id,
                        event.target.checked,
                        catalog,
                        STUDIO_PLUGIN_ENVIRONMENT,
                      ),
                    )
                  }
                  type="checkbox"
                />
                Enabled
              </label>
            )}
          </header>
          {selected.description && <p>{selected.description}</p>}
          <dl>
            <div>
              <dt>Source</dt>
              <dd title={sourceLabel(selected.source)}>
                {sourceLabel(selected.source)}
              </dd>
            </div>
            <div>
              <dt>Targets</dt>
              <dd>
                {[
                  selectedAuthoring?.altairVersion
                    ? `Altair ${selectedAuthoring.altairVersion}`
                    : "",
                  selected.targets?.runtimes?.length
                    ? selected.targets.runtimes.join("/")
                    : "",
                  selected.targets?.engineVersion
                    ? `Engine ${selected.targets.engineVersion}`
                    : "",
                  selected.targets?.platforms?.length
                    ? selected.targets.platforms.join("/")
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "Any"}
              </dd>
            </div>
          </dl>
          <div className="plugin-meta-group">
            <span>Permissions</span>
            <div className="plugin-chips">
              {(selectedPermissions.length ? selectedPermissions : ["None"]).map((permission) => (
                <code
                  className={
                    installed?.permissions?.includes(permission)
                      ? "granted"
                      : undefined
                  }
                  key={permission}
                >
                  {permission}
                </code>
              ))}
            </div>
            {installed && selectedPermissions.length > 0 && (
              <div className="plugin-permission-actions">
                <small>
                  {selectedGrantedPermissions.length}/{selectedPermissions.length} granted
                </small>
                {selectedMissingPermissions.length > 0 && (
                  <button onClick={grantPermissions}>
                    Grant {selectedMissingPermissions.length}
                  </button>
                )}
                {selectedGrantedPermissions.length > 0 && (
                  <button onClick={revokePermissions}>Revoke</button>
                )}
              </div>
            )}
          </div>
          {selectedDiagnostics.length > 0 && (
            <ul className="plugin-diagnostics">
              {selectedDiagnostics.map((item) => (
                <li
                  className={item.severity}
                  key={`${item.code}:${item.pluginId}:${item.relatedPluginId ?? ""}`}
                >
                  {item.message}
                </li>
              ))}
            </ul>
          )}
          {selectedPreviewHostMissing && (
            <p className="plugin-error" role="alert">
              Enabled metadata has no trusted browser or broker implementation.
            </p>
          )}
          {installed && (
            <>
              <label className="plugin-configuration">
                <span>Configuration</span>
                <textarea
                  aria-label={`${selected.name} configuration`}
                  onChange={(event) =>
                    setConfigurationText(event.target.value)
                  }
                  spellCheck={false}
                  value={configurationText}
                />
              </label>
              <div className="plugin-actions">
                <button onClick={saveConfiguration}>Apply</button>
                <button
                  className="danger"
                  disabled={installed.required}
                  onClick={() =>
                    apply((current) =>
                      marketplace.remove(current, selected.id, catalog),
                    )
                  }
                >
                  Uninstall
                </button>
                {installed.required && <small>Required by project</small>}
              </div>
            </>
          )}
        </div>
      )}

      {(actionError || catalogError) && (
        <p className="plugin-error" role="alert">
          {actionError || catalogError}
        </p>
      )}

      <details className="catalog-source">
        <summary>Catalog source</summary>
        <div>
          <input
            aria-label="HTTP catalog URL"
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://…/catalog.json"
            type="url"
            value={remoteUrl}
          />
          <button
            disabled={catalogBusy || !remoteUrl.trim()}
            onClick={() => void addRemoteCatalog()}
          >
            {catalogBusy ? "Loading" : "Add"}
          </button>
        </div>
        <small>JSON metadata only. Packages are not executed.</small>
      </details>
    </section>
  );
}
