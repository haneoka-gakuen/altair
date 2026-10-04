import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

self.MonacoEnvironment ??= {
  getWorker: (_module, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};
export function HistoryDiff({ path, historical, current }: { path: string; historical: string; current: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const models = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!mount.current) return;
    const language = /\.ya?ml$/iu.test(path) ? "yaml" : /\.json$/iu.test(path) ? "json" : "plaintext";
    const original = monaco.editor.createModel(historical, language),
      modified = monaco.editor.createModel(current, language);
    const editor = monaco.editor.createDiffEditor(mount.current, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 2,
      lineDecorationsWidth: 0,
      glyphMargin: false,
      fontSize: 12,
    });
    editor.setModel({ original, modified });
    models.current = { original, modified };
    return () => {
      models.current = undefined;
      editor.setModel(null);
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [path]);
  useEffect(() => {
    models.current?.original.setValue(historical);
    models.current?.modified.setValue(current);
  }, [historical, current]);
  return <div ref={mount} className="history-diff-mount" />;
}
