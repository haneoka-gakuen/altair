import { createVega, vegaProjectToAdvStory, createVegaPlayerState } from "@haneoka/vega/web";
import { createCubismWebRuntimeAdapter } from "@haneoka/vega-plugin-cubism/web-runtime";
import { createSpineThreeRuntimeAdapter } from "@haneoka/vega-plugin-spine/three";
import { parseVegaProject } from "@haneoka/vega-protocol";
import { createVegaFullPreset } from "@haneoka/vega-preset-full";
import "./game-player.css";
const controller = new AbortController();
async function start() {
  const response = await fetch("project.json", { signal: controller.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const project = parseVegaProject(await response.text()),
    story = vegaProjectToAdvStory(project);
  document.documentElement.lang =
    typeof project.metadata?.locale === "string" && project.metadata.locale !== "und"
      ? project.metadata.locale
      : navigator.language;
  const runtimeResponse = await fetch("engine/runtime.json", { signal: controller.signal });
  const runtime = runtimeResponse.ok ? await runtimeResponse.json() : {};
  let spineAdapter;
  if (project.plugins?.some((plugin) => plugin.id === "haneoka.spine")) {
    const [three, spine] = await Promise.all([import("three"), import("@esotericsoftware/spine-threejs")]);
    spineAdapter = createSpineThreeRuntimeAdapter({ three, spine });
  }

  const state = createVegaPlayerState();
  state.paused = true;
  const theme = "haneoka";
  const richText = Object.fromEntries(
    ["bbcode", "html", "latex", "markdown", "typst"].map((format) => [
      format,
      project.plugins?.some((plugin) => plugin.id === `haneoka.vega-richtext-${format}`) ?? false,
    ]),
  );
  const engine = createVega({
    plugins: createVegaFullPreset({
      theme,
      cubism: createCubismWebRuntimeAdapter({ runtime }),
      ...(spineAdapter ? { spine: spineAdapter } : {}),
      richText,
    }),
  });
  const player = await engine.createPlayer({
    mount: document.getElementById("stage")!,
    story,
    state,
    theme,
    renderBackend: "vega-three-webgl2",
    shell: { projectId: project.id, initialScreen: "title" },
  });
  if (typeof story.vegaEntryKey === "string") player.player.navigateToKey(story.vegaEntryKey);
  document.title = typeof project.title === "string" ? project.title : Object.values(project.title)[0] || "Vega";
  const playback = player.player.play();
  void playback.catch(showError);
  window.addEventListener(
    "pagehide",
    () => {
      controller.abort();
      void engine.dispose();
    },
    { once: true },
  );
}
function showError(error: unknown) {
  const output = document.getElementById("error")!;
  output.hidden = false;
  output.textContent = error instanceof Error ? error.message : String(error);
}
void start().catch(showError);
