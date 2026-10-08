import { createHaneokaResourceBrowserProvider } from "@haneoka/altair-plugin-haneoka";
import { createAltairBestdoriResourceProvider } from "@haneoka/altair-plugin-bestdori";
import { createStudioPublicResourceHost } from "./public-resource-host";
/** Public package entry points; each connection creates its own source scope and byte owner. */
export const studioPublicResourceHost = createStudioPublicResourceHost({
  factories: { haneoka: createHaneokaResourceBrowserProvider, bestdori: createAltairBestdoriResourceProvider },
});
