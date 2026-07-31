import type {
  VegaPluginInstallSource,
  VegaPluginLock,
  VegaPluginLockEntry,
  VegaPluginLockTarget,
} from "@haneoka/vega-protocol";

/** Canonical immutable lock envelope shared with Vega and Deneb. */
export type AltairPluginLock = VegaPluginLock;
export type AltairPluginLockEntry = VegaPluginLockEntry;
export type AltairPluginLockTarget = VegaPluginLockTarget;
export type AltairPluginInstallSource = VegaPluginInstallSource;

/**
 * Authoring-only metadata carried beside canonical marketplace entries.
 * Catalog loading, dependency solving, installation, and mutation are plugin
 * responsibilities and deliberately absent from core.
 */
export interface AltairAuthoringPluginMetadata {
  readonly scope: "authoring" | "runtime" | "host";
  readonly permissions?: readonly string[];
}
