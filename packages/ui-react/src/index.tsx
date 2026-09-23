import { createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AltairEditorWorkspace, AltairPanelContext } from "@haneoka/altair";
export { NumberInput } from "./NumberInput.js";
export { StructuredTextInput } from "./StructuredTextInput.js";

const EditorContext = createContext<AltairEditorWorkspace | undefined>(undefined);
export function useEditorWorkspace(): AltairEditorWorkspace {
  const workspace = useContext(EditorContext);
  if (!workspace) throw new Error("An editor workspace is required");
  return workspace;
}
export const useEditorTranslator = () => useEditorWorkspace().translate;

export function mountReactEditor(host: HTMLElement, context: AltairPanelContext, element: ReactNode) {
  if (!context.editor) throw new Error("An editor workspace is required");
  context.signal.throwIfAborted();
  const root = createRoot(host);
  root.render(createElement(EditorContext.Provider, { value: context.editor }, element));
  return {
    dispose() {
      root.unmount();
    },
  };
}
