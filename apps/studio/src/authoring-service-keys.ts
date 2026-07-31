import { defineAltairService } from "@haneoka/altair";
import type { AltairAdvService } from "@haneoka/altair-plugin-adv";
import type { AltairMarketplaceService } from "@haneoka/altair-plugin-marketplace";
import type { AltairVegaPreviewService } from "@haneoka/altair-plugin-vega-preview";
import type { AltairBrowserWorkspaceService } from "@haneoka/altair-plugin-workspace-browser";
import type { AltairHistoryService } from "@haneoka/altair-plugin-history";
import type { AltairDraftService } from "@haneoka/altair-plugin-drafts";
import type { AltairWebGalService } from "@haneoka/altair-plugin-webgal";

/**
 * Structural keys keep Studio's initial bundle independent from optional
 * implementation modules. The broker loads implementations only on demand.
 */
export const studioMarketplaceServiceKey =
  defineAltairService<AltairMarketplaceService>(
    "haneoka.altair.marketplace",
  );

export const studioAdvServiceKey =
  defineAltairService<AltairAdvService>("haneoka.altair.adv");

export const studioVegaPreviewServiceKey =
  defineAltairService<AltairVegaPreviewService>(
    "haneoka.altair.services.vega-preview",
  );

export const studioBrowserWorkspaceServiceKey =
  defineAltairService<AltairBrowserWorkspaceService>(
    "haneoka.altair.workspace.browser",
  );

export const studioWebGalServiceKey =
  defineAltairService<AltairWebGalService>(
    "haneoka.altair.webgal",
  );

export const studioHistoryServiceKey =
  defineAltairService<AltairHistoryService>(
    "haneoka.altair.history",
  );

export const studioDraftServiceKey =
  defineAltairService<AltairDraftService>(
    "haneoka.altair.drafts",
  );
