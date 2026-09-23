import type { AltairAuthoredNode, AltairCommandGroup, JsonObject } from "@haneoka/altair";
import { nativeCommands } from "./native-project";
import { tr } from "./i18n";
export interface TimelineCue {
  node: AltairAuthoredNode;
  atSeconds: number;
  role: "lifetime" | "event";
  durationSeconds: number;
  track: JsonObject;
}
export const isTimeline = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "timeline";
export function durationField(node: AltairAuthoredNode): { key: string; scale: number } | undefined {
  for (const key of ["durationMs", "duration", "fadeDuration", "transitionDuration"])
    if (Object.hasOwn(node.arguments, key)) return { key, scale: key === "durationMs" ? 1000 : 1 };
  const definition = nativeCommands.find(
    (command) => node.type.plugin === "haneoka.altair-adv" && command.name === node.type.name,
  );
  const key = definition?.fields.find((field) =>
    ["duration", "fadeDuration", "transitionDuration"].includes(field.key),
  )?.key;
  return key ? { key, scale: 1 } : undefined;
}
export function cueDuration(node: AltairAuthoredNode): number {
  if (isTimeline(node))
    return Math.max(
      0,
      Number(node.arguments.durationSeconds) || 0,
      ...timelineCues(node).map((cue) => cue.atSeconds + cue.durationSeconds),
    );
  const field = durationField(node);
  return field ? Math.max(0, Number(node.arguments[field.key]) / field.scale || 0) : 0;
}
export function timelineCues(node: AltairAuthoredNode): TimelineCue[] {
  if (!isTimeline(node) || !Array.isArray(node.arguments.tracks)) return [];
  return node.arguments.tracks.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(tr("Invalid timeline cue"));
    const child = node.children?.find((child) => child.id === value.nodeId);
    if (!child) throw Error(tr("Timeline command is missing"));
    const atSeconds = Number(value.atSeconds ?? 0);
    if (!Number.isFinite(atSeconds) || atSeconds < 0) throw Error(tr("Invalid cue start time"));
    return {
      node: child,
      atSeconds,
      role: value.role === "event" ? "event" : "lifetime",
      durationSeconds: cueDuration(child),
      track: value,
    };
  });
}
export function createTimeline(children: readonly AltairAuthoredNode[] = [], sequential = false): AltairAuthoredNode {
  let cursor = 0,
    duration = 0;
  const tracks = children.map((node) => {
    const atSeconds = cursor,
      seconds = cueDuration(node);
    duration = Math.max(duration, atSeconds + seconds);
    if (sequential && node.arguments.noWait !== true && node.arguments.parallel !== true) cursor += seconds;
    return { nodeId: node.id, atSeconds, role: "lifetime" };
  });
  return {
    id: crypto.randomUUID(),
    type: { plugin: "haneoka.altair", name: "timeline" },
    schemaVersion: 1,
    arguments: {
      tracks,
      waitForPrevious: true,
      cancelOnManualAdvance: false,
      durationSeconds: duration,
    },
    children: [...children],
  };
}
export function updateCue(
  node: AltairAuthoredNode,
  id: string,
  atSeconds: number,
  duration?: number,
  role?: "lifetime" | "event",
): AltairAuthoredNode {
  if (
    !Number.isFinite(atSeconds) ||
    atSeconds < 0 ||
    (duration !== undefined && (!Number.isFinite(duration) || duration < 0))
  )
    throw Error(tr("Invalid cue timing"));
  const cues = timelineCues(node);
  if (!cues.some((cue) => cue.node.id === id)) throw Error(tr("Timeline command is missing"));
  const children = node.children!.map((child) => {
    const field = durationField(child);
    return child.id === id && duration !== undefined && field
      ? {
          ...child,
          arguments: {
            ...child.arguments,
            [field.key]: duration * field.scale,
          },
        }
      : child;
  });
  const tracks = cues.map((cue) => ({
    ...cue.track,
    ...(cue.node.id === id ? { atSeconds, ...(role ? { role } : {}) } : {}),
  }));
  return { ...node, children, arguments: { ...node.arguments, tracks } };
}
export function removeCue(node: AltairAuthoredNode, id: string): AltairAuthoredNode {
  return {
    ...node,
    children: node.children?.filter((child) => child.id !== id),
    arguments: {
      ...node.arguments,
      tracks: timelineCues(node)
        .filter((cue) => cue.node.id !== id)
        .map((cue) => cue.track),
    },
  };
}
export async function importTimelineScript(source: string): Promise<AltairCommandGroup> {
  const { importWebGal, webGalCommandToAuthoredNode } = await import("@haneoka/altair-plugin-webgal");
  const imported = importWebGal(source, {
    sceneId: crypto.randomUUID(),
    title: tr("Imported timeline"),
  });
  const errors = imported.diagnostics.filter((item) => item.severity === "error");
  if (errors.length) throw Error(errors.map((item) => item.message).join("\n"));
  const nodes = imported.project.scenes[0]!.commands.map(webGalCommandToAuthoredNode);
  if (!nodes.length) throw Error(tr("No commands found"));
  const timeline = nodes.length === 1 && isTimeline(nodes[0]!) ? nodes[0]! : createTimeline(nodes, true);
  return {
    id: crypto.randomUUID(),
    name: tr("Imported timeline"),
    sourceSceneId: imported.project.scenes[0]!.id,
    nodes: [timeline],
    plugins: imported.project.plugins ?? [],
  };
}
