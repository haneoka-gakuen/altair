import { studioI18n } from "./i18n";
export const monacoLanguage = studioI18n.resolvedLanguage ?? "en";
const locales: Record<string, () => Promise<unknown>> = {
  ja: () => import("monaco-editor/nls/lang/ja.js"),
  ko: () => import("monaco-editor/nls/lang/ko.js"),
  "zh-CN": () => import("monaco-editor/nls/lang/zh-cn.js"),
  "zh-TW": () => import("monaco-editor/nls/lang/zh-tw.js"),
};
await locales[monacoLanguage]?.();
export const monaco = await import("monaco-editor");
