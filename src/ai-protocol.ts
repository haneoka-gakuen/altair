import type { StoryDiagnostic } from "./diagnostics.js";
import type { StoryProject } from "./model.js";

/**
 * Pure authoring protocol for AI-backed or deterministic adaptation plugins.
 *
 * Altair core owns only this data contract. Provider implementations, model
 * clients, prompt logic, and project mutation helpers live in plugins.
 */
export interface AltairAdaptationRequest {
  readonly source: string;
  readonly title?: string;
  readonly locale?: string;
  readonly instructions?: string;
  readonly existingProject?: StoryProject;
}

export interface AltairAiProvenance {
  readonly provider: string;
  readonly model?: string;
  readonly generatedAt: string;
  readonly sourceHash?: string;
  readonly reviewed: boolean;
}

export interface AltairAdaptationResult {
  readonly project: StoryProject;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly provenance: AltairAiProvenance;
}

export interface AltairAiProvider {
  readonly id: string;
  readonly name: string;
  adapt(request: AltairAdaptationRequest, signal: AbortSignal): Promise<AltairAdaptationResult>;
}
