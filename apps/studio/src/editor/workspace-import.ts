import {
  AltairPluginHost,
  altairWorkspaceImporterService,
  type AltairWorkspaceImportRequest,
  type JsonObject,
} from "@haneoka/altair";
import loadImporters from "virtual:altair-workspace-importers";

export async function importWorkspaceDocument(value: JsonObject, request: () => Promise<AltairWorkspaceImportRequest>) {
  if (!loadImporters.length) return;
  const host = new AltairPluginHost();
  try {
    for (const load of loadImporters) {
      const plugin = await load();
      await host.install(plugin);
      const importer = host.service(altairWorkspaceImporterService(plugin.manifest.id));
      if (importer?.recognizes(value)) return await importer.import(value, await request());
    }
  } finally {
    await host.dispose();
  }
}
