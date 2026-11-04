import { useEditorPreferences } from "./preferences";
import { studioIntent } from "./studio-host";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { monaco, monacoLanguage } from "./monaco-locale";
import { useStudioI18n } from "./i18n";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import { useEffect, useRef } from "react";
import { formatAuthoredText } from "@haneoka/altair";
import type { EditorSession, EditorDocument } from "./session";
import { EDITOR_COMMANDS } from "./commands";
import { nativeScriptLanguage } from "@haneoka/altair-plugin-webgal/native-script";
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
monaco.languages.register({ id: "ournotes" });
monaco.languages.setLanguageConfiguration("ournotes", {
  comments: { lineComment: ";" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
  ],
});
monaco.languages.setMonarchTokensProvider("ournotes", {
  tokenizer: {
    root: [
      [/^\s*;.*/, "comment"],
      [/^[\w.]+(?=:)/, "keyword"],
      [/-[\w]+(?==|\s|;|$)/, "attribute.name"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}\[\],:;]/, "delimiter"],
    ],
  },
});
monaco.languages.registerCompletionItemProvider("ournotes", {
  triggerCharacters: ["-"],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const command = nativeScriptLanguage().find((entry) => before.trimStart().startsWith(`${entry.name}:`));
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
    if (command && /-\w*$/u.test(before))
      return {
        suggestions: command.fields.map((field) => ({
          label: field.name,
          insertText: field.text.slice(1),
          range,
          kind: monaco.languages.CompletionItemKind.Property,
        })),
      };
    return {
      suggestions: [
        ...nativeScriptLanguage().map((entry) => ({ label: entry.name, detail: entry.label, insertText: entry.text })),
        ...EDITOR_COMMANDS.filter((entry) => entry.name !== "comment").map((entry) => ({
          label: entry.name,
          detail: entry.label,
          insertText: entry.initial,
        })),
      ].map((entry) => ({ ...entry, range, kind: monaco.languages.CompletionItemKind.Function })),
    };
  },
});
function validateModel(model: Monaco.editor.ITextModel, path: string, session: EditorSession): void {
  const markers: Monaco.editor.IMarkerData[] = [];
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
function syncSourceTheme(editor: Monaco.editor.IStandaloneCodeEditor | null) {
  const root = globalThis.document.documentElement;
  const style = getComputedStyle(root);
  const role = (name: string) => style.getPropertyValue(`--md-sys-color-${name}`).trim();
  monaco.editor.defineTheme("altair-host", {
    base: root.dataset.theme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": role("surface"),
      "editor.foreground": role("on-surface"),
      "editorLineNumber.foreground": role("on-surface-variant"),
      "editorLineNumber.activeForeground": role("primary"),
      "editor.selectionBackground": role("secondary-container"),
    },
  });
  monaco.editor.setTheme("altair-host");
  editor?.updateOptions({ fontFamily: `ui-monospace, ${style.getPropertyValue("--app-font").trim() || "monospace"}` });
  monaco.editor.remeasureFonts();
}
export default function SourceEditor({
  session,
  document,
  line,
  language,
  onChange,
  onSelect,
  error,
}: {
  session: EditorSession;
  document: EditorDocument;
  line?: number;
  language?: string;
  onChange?(text: string): void;
  onSelect?(line: number): void;
  error?: string;
}) {
  const preferences = useEditorPreferences();
  const { i18n, t } = useStudioI18n();
  useEffect(() => {
    if (i18n.resolvedLanguage !== monacoLanguage && window.parent === window)
      void session.dispose().then(() => location.reload());
  }, [i18n.resolvedLanguage, session]);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectionHandler = useRef(onSelect);
  selectionHandler.current = onSelect;
  useEffect(() => {
    const refresh = () => syncSourceTheme(editor.current);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(globalThis.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "lang"],
    });
    globalThis.document.fonts.addEventListener("loadingdone", refresh);
    return () => {
      observer.disconnect();
      globalThis.document.fonts.removeEventListener("loadingdone", refresh);
    };
  }, []);
  const onMount: OnMount = (instance) => {
    editor.current = instance;
    syncSourceTheme(instance);
    if (instance.getModel()) validateModel(instance.getModel()!, document.path, session);
    instance.onDidChangeCursorPosition((event) => {
      if (selectionHandler.current) selectionHandler.current(event.position.lineNumber);
      else if (!onChange) session.select(event.position.lineNumber);
    });
    instance.onDidBlurEditorText(() => session.endGesture());
    if (line !== undefined) {
      const startLine = Math.min(instance.getModel()?.getLineCount() ?? 1, Math.max(1, line));
      instance.setPosition({ lineNumber: startLine, column: 1 });
      instance.revealLineInCenterIfOutsideViewport(startLine);
    }
    const undo = () => {
      session.endGesture();
      session.undo();
    };
    const redo = () => {
      session.endGesture();
      session.redo();
    };
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, undo);
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, redo);
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, redo);
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!studioIntent("save")) void session.save().catch(() => {});
    });
  };
  useEffect(() => {
    if (line !== undefined && editor.current?.getPosition()?.lineNumber !== line) {
      editor.current?.setPosition({ lineNumber: line, column: 1 });
      editor.current?.revealLineInCenterIfOutsideViewport(line);
    }
  }, [line]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) {
      if (!onChange) validateModel(model, document.path, session);
      monaco.editor.setModelMarkers(
        model,
        "source",
        error
          ? [
              {
                severity: monaco.MarkerSeverity.Error,
                message: error,
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: 1,
                endColumn: model.getLineMaxColumn(1),
              },
            ]
          : [],
      );
    }
  }, [document.path, document.text, session, onChange, error]);
  return (
    <Editor
      theme="altair-host"
      path={document.path}
      language={
        language ??
        (document.path.endsWith(".jsonl")
          ? "jsonl"
          : document.path.endsWith(".json") || document.path.endsWith(".wgcp")
            ? "json"
            : /\.ya?ml$/iu.test(document.path)
              ? "yaml"
              : /\.(wg|webgal)$/iu.test(document.path)
                ? "webgal"
                : "plaintext")
      }
      value={document.text}
      onChange={(value) => (onChange ? onChange(value ?? "") : session.update(document.path, value ?? "", true))}
      onMount={onMount}
      options={{
        ariaLabel: t(language === "ournotes" ? "authoring.source" : "Source"),
        editContext: false,
        readOnly: Boolean(session.getSnapshot().nativeImportRecovery),
        fontSize: preferences.fontSize,
        lineHeight: 24,
        fontFamily: `ui-monospace, ${getComputedStyle(globalThis.document.documentElement).getPropertyValue("--app-font").trim() || "monospace"}`,
        minimap: { enabled: preferences.minimap },
        wordWrap: preferences.wordWrap ? "on" : "off",
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 18, bottom: 18 },
        tabSize: preferences.tabSize,
        insertSpaces: true,
      }}
    />
  );
}
