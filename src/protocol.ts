/**
 * Browser-neutral authoring contracts shared by Altair hosts and plugins.
 *
 * This entry point deliberately exports data types and contribution protocols,
 * not codecs, compilers, AI implementations, preview runtimes, or workspace
 * adapters.
 */
export * from "./diagnostics.js";
export * from "./model.js";
export type * from "./ai-protocol.js";
export type * from "./plugin-metadata.js";
export * from "./plugin-contributions.js";
export type * from "./resource-browser.js";
