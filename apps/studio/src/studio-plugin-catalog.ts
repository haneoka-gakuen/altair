import type { StoryProjectPlugin } from "@haneoka/altair/protocol";
import type { AltairPluginCatalog } from "@haneoka/altair-plugin-marketplace";
import { createAltairFullPresetProjectPlugins } from "@haneoka/altair-preset-full";
import { vegaOfficialPluginCatalog } from "@haneoka/vega-catalog-official";

export const STUDIO_PLUGIN_CATALOG = Object.freeze({
  ...vegaOfficialPluginCatalog,
  extensions: {
    altair: {
      entries: {
        "haneoka.altair-models@0.1.0": {
          scope: "authoring",
          permissions: ["project.read", "project.write"],
        },
        "haneoka.altair-adv@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-bestdori@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-flow@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-history@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-drafts@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-marketplace@0.1.0": {
          scope: "authoring",
          permissions: ["network:http"],
        },
        "haneoka.altair-prose@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-vega-preview@0.1.0": {
          scope: "authoring",
          permissions: [],
        },
        "haneoka.altair-webgal@0.1.0": {
          scope: "authoring",
          permissions: ["project.read", "project.write"],
        },
        "haneoka.altair-workspace-browser@0.1.0": {
          scope: "authoring",
          permissions: ["filesystem:read", "filesystem:write"],
        },
      },
    },
  },
} as const) satisfies AltairPluginCatalog;

export const DEFAULT_STUDIO_PROJECT_PLUGINS: readonly StoryProjectPlugin[] = createAltairFullPresetProjectPlugins();

export const STUDIO_PLUGIN_ENVIRONMENT = {
  altairVersion: "0.1.0",
  runtime: "vega",
  platform: "web",
  engineVersion: "0.1.0",
  apiVersion: 1,
  altairApiVersion: 2,
} as const;
