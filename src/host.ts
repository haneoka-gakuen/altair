/**
 * Narrow entry point for the Altair extension host.
 *
 * Importing this module creates no host and activates no authoring feature.
 * Applications explicitly construct an `AltairPluginHost` and install the
 * plugins selected by their project or preset.
 */
export * from "./plugins.js";
