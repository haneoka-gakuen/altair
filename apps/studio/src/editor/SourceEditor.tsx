import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import { useEffect, useRef } from "react";
import { formatAuthoredText } from "@haneoka/altair";
import type { EditorSession, EditorDocument } from "./session";
import { EDITOR_COMMANDS } from "./commands";
self.MonacoEnvironment = {
  getWorker: (_module, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco });
monaco.languages.register({ id: "jsonl" });
monaco.languages.setMonarchTokensProvider("jsonl", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "attribute.name"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}\[\],:]/, "delimiter"],
    ],
  },
});
monaco.languages.register({ id: "webgal" });
monaco.languages.setMonarchTokensProvider("webgal", {
  tokenizer: {
    root: [
      [/^\s*;.*/, "comment"],
      [/^[\w]+(?=:)/, "keyword"],
      [/-[\w]+(?==|\s|;|$)/, "attribute.name"],
      [/\{.*\}/, "string"],
      [/;.*/, "comment"],
    ],
  },
});
monaco.languages.registerCompletionItemProvider("webgal", {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    return {
      suggestions: EDITOR_COMMANDS.filter((command) => command.name !== "comment").map((command) => ({
        label: command.name,
        detail: command.label,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: command.initial,
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        },
      })),
    };
  },
});
monaco.languages.registerDocumentFormattingEditProvider("yaml", {
  provideDocumentFormattingEdits(model) {
    try {
      return [{ range: model.getFullModelRange(), text: formatAuthoredText(model.getValue()) }];
    } catch {
      return [];
    }
  },
});
function validateModel(model: monaco.editor.ITextModel, path: string, session: EditorSession): void {
  const markers: monaco.editor.IMarkerData[] = [];
  if (/\.ya?ml$/iu.test(path)) {
    try {
      session.validateDocument(path, model.getValue());
    } catch (error) {
      const issue = error as { message?: string; linePos?: { line: number; col: number }[] };
      const start = issue.linePos?.[0] ?? { line: 1, col: 1 };
      const end = issue.linePos?.[1] ?? { line: start.line, col: model.getLineMaxColumn(start.line) };
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        message: issue.message ?? String(error),
        startLineNumber: start.line,
        startColumn: start.col,
        endLineNumber: end.line,
        endColumn: Math.max(end.col, start.col + 1),
      });
    }
  }
  monaco.editor.setModelMarkers(model, "authored", markers);
}
export default function SourceEditor({
  session,
  document,
  line,
}: {
  session: EditorSession;
  document: EditorDocument;
  line: number;
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onMount: OnMount = (instance) => {
    editor.current = instance;
    if (instance.getModel()) validateModel(instance.getModel()!, document.path, session);
    instance.onDidChangeCursorPosition((event) => session.select(event.position.lineNumber));
    instance.onDidBlurEditorText(() => session.endGesture());
    const startLine = Math.min(instance.getModel()?.getLineCount() ?? 1, Math.max(1, line));
    instance.setPosition({ lineNumber: startLine, column: 1 });
    instance.revealLineInCenterIfOutsideViewport(startLine);
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void session.save().catch(() => {}));
  };
  useEffect(() => {
    if (editor.current?.getPosition()?.lineNumber !== line) {
      editor.current?.setPosition({ lineNumber: line, column: 1 });
      editor.current?.revealLineInCenterIfOutsideViewport(line);
    }
  }, [line]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) validateModel(model, document.path, session);
  }, [document.path, document.text]);
  return (
    <Editor
      path={document.path}
      language={
        document.path.endsWith(".jsonl")
          ? "jsonl"
          : document.path.endsWith(".json") || document.path.endsWith(".wgcp")
            ? "json"
            : /\.ya?ml$/iu.test(document.path)
              ? "yaml"
              : /\.(wg|webgal)$/iu.test(document.path)
                ? "webgal"
                : "plaintext"
      }
      value={document.text}
      onChange={(value) => session.update(document.path, value ?? "", true)}
      onMount={onMount}
      options={{
        fontSize: 14,
        lineHeight: 24,
        fontFamily: '"Noto Sans Mono", monospace',
        minimap: { enabled: false },
        wordWrap: "on",
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 18, bottom: 18 },
        tabSize: 2,
        insertSpaces: true,
      }}
    />
  );
}
