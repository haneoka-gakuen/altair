import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  parseAltairCommandLibrary,
  parseAuthoredText,
} from "@haneoka/altair";
import { NATIVE_PROJECT_PATH, nativeScenePath } from "./native-project";
import { COMMAND_LIBRARY_PATH } from "./command-library";
import { tr } from "./i18n";
export function authoredError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const scene = /^(?:Target|Branch) scene is missing: (.+)$/u.exec(message);
  if (scene) return tr("Missing scene: {{scene}}", { scene: scene[1] });
  const node = /^(?:Target node is missing|Target node is not executable): (.+)$/u.exec(message);
  if (node) return tr("Missing command: {{node}}", { node: node[1] });
  if (message === "Target scene is required") return tr("Select a target scene");
  return tr(message);
}
export function validateAuthoredDocument(path: string, text: string): void {
  if (path === NATIVE_PROJECT_PATH) parseAltairProjectDocument(text);
  else if (nativeScenePath(path)) parseAltairSceneDocument(text);
  else if (path === COMMAND_LIBRARY_PATH) parseAltairCommandLibrary(text);
  else if (/\.ya?ml$/iu.test(path)) parseAuthoredText(text);
}
