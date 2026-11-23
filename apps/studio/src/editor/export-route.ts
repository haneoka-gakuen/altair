import { VEGA_ADV_OPCODE, VEGA_SYSTEM_OPCODE, type VegaPreviewRouteDecision } from "@haneoka/vega-protocol";
import type { JsonObject, JsonValue, StoryProject } from "@haneoka/altair";
import type { CompileVegaPreviewStoryResult } from "@haneoka/altair-plugin-vega-preview";
import { resolveStoryLocalizedText } from "@haneoka/vega/runtime";
import { tr } from "./i18n";

export const exportRoutesKey = "haneoka.exportRoutes";
export type RouteAnswer = string | number;
export interface ExportRoute {
  id: string;
  name: string;
  sceneId: string;
  answers: Record<string, RouteAnswer[]>;
  variables?: JsonObject;
}
export interface RoutePrompt {
  id: string;
  commandIndex: number;
  sceneId: string;
  label: string;
  options?: { value: number; label: string }[];
  numeric?: boolean;
}
const record = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export function savedExportRoutes(project: Pick<StoryProject, "extensions"> | undefined): ExportRoute[] {
  const rows = project?.extensions[exportRoutesKey];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const { id, name, sceneId, answers, variables } = record(row);
    if (typeof id !== "string" || typeof name !== "string" || typeof sceneId !== "string") return [];
    return [
      {
        id,
        name,
        sceneId,
        ...(variables ? { variables: record(variables) } : {}),
        answers: Object.fromEntries(
          Object.entries(record(answers)).filter(
            (entry): entry is [string, RouteAnswer[]] =>
              Array.isArray(entry[1]) &&
              entry[1].every((value) => typeof value === "string" || typeof value === "number"),
          ),
        ),
      },
    ];
  });
}
export function routePrompts(project: StoryProject, compilation: CompileVegaPreviewStoryResult): RoutePrompt[] {
  const commands = (compilation.story as JsonObject).commands;
  if (!Array.isArray(commands)) return [];
  const ordinals = new Map<string, number>();
  const scenes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  return compilation.commandMappings.flatMap<RoutePrompt>((mapping) => {
    const command = record(commands[mapping.commandIndex]);
    if (command.command !== VEGA_ADV_OPCODE.ChoiceShow && command.command !== VEGA_SYSTEM_OPCODE.Input) return [];
    if (command.ignoreData) return [];
    const source = scenes.get(mapping.sceneId)?.commands[mapping.sourceCommandIndex];
    if (!source) return [];
    const location = [mapping.sceneId, source.id].map(encodeURIComponent).join("/");
    const ordinal = ordinals.get(location) ?? 0;
    ordinals.set(location, ordinal + 1);
    const base = { id: location + "/" + ordinal, commandIndex: mapping.commandIndex, sceneId: mapping.sceneId };
    if (command.command === VEGA_SYSTEM_OPCODE.Input) {
      return [
        {
          ...base,
          label: String(command.prompt || command.variable || tr("Text input")),
          numeric: command.inputType === "number",
        },
      ];
    }
    const options = Array.isArray(command.choices)
      ? command.choices.map((item) => {
          const choice = record(item);
          return { value: Number(choice.choiceValue), label: resolveStoryLocalizedText(choice.text).text };
        })
      : [];
    const label = tr("Choice at statement {{number}}", { number: mapping.sourceCommandIndex + 1 });
    return [{ ...base, label, options }];
  });
}
export function compileRouteAnswers(route: ExportRoute, prompts: RoutePrompt[]): VegaPreviewRouteDecision[] {
  const available = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  return Object.entries(route.answers).flatMap(([id, values]) => {
    if (!values.length) return [];
    const prompt = available.get(id);
    if (!prompt || (prompt.options && values.some((value) => !prompt.options!.some((item) => item.value === value))))
      throw new Error(tr("The saved choice is unavailable"));
    return [{ commandIndex: prompt.commandIndex, values }];
  });
}
