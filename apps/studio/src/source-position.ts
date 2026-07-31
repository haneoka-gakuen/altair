import type { StoryProject } from "@haneoka/altair";

/** Map a physical source line to the nearest executable Vega command. */
export const commandIndexForSourceLine = (
  project: StoryProject,
  sceneId: string,
  commandSourceIndexes: readonly number[],
  line: number,
  commandIndexes?: readonly number[],
): number => {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene || !commandSourceIndexes.length) return 0;
  let sourceIndex = 0;
  for (const [index, command] of scene.commands.entries()) {
    if ((command.source?.line ?? index + 1) <= line) sourceIndex = index;
  }
  let compiledIndex = 0;
  for (const [index, candidate] of commandSourceIndexes.entries()) {
    if (candidate <= sourceIndex) compiledIndex = index;
  }
  return commandIndexes?.[compiledIndex] ?? compiledIndex;
};
