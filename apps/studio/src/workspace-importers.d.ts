declare module "virtual:altair-workspace-importers" {
  const loadImporters: readonly (() => Promise<import("@haneoka/altair").AltairPlugin>)[];
  export default loadImporters;
}
