import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  parseAltairCommandLibrary,
  parseAuthoredText,
} from "@haneoka/altair";
import { NATIVE_PROJECT_PATH, nativeScenePath } from "./native-project";
import { COMMAND_LIBRARY_PATH } from "./command-library";
export function validateAuthoredDocument(path: string, text: string): void {
  if (path === NATIVE_PROJECT_PATH) parseAltairProjectDocument(text);
  else if (nativeScenePath(path)) parseAltairSceneDocument(text);
  else if (path === COMMAND_LIBRARY_PATH) parseAltairCommandLibrary(text);
  else if (/\.ya?ml$/iu.test(path)) parseAuthoredText(text);
}
