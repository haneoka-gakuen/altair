export type AiProtocol = "responses" | "chat" | "anthropic" | "gemini";
export type AiTask = "edit" | "director" | "translate" | "vision";
export type AiFormat = "schema" | "json" | "prompt";
export interface AiPreset {
  id: string;
  label: string;
  protocol: AiProtocol;
  endpoint: string;
  local?: boolean;
  format?: AiFormat;
}
export const AI_PRESETS: readonly AiPreset[] = [
  { id: "openai", label: "OpenAI", protocol: "responses", endpoint: "https://api.openai.com/v1", format: "schema" },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    format: "schema",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    format: "schema",
  },
  { id: "deepseek", label: "DeepSeek", protocol: "chat", endpoint: "https://api.deepseek.com/v1", format: "json" },
  {
    id: "qwen-cn",
    label: "ai.qwenChina",
    protocol: "chat",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "qwen-intl",
    label: "ai.qwenGlobal",
    protocol: "chat",
    endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  { id: "kimi-cn", label: "ai.kimiChina", protocol: "chat", endpoint: "https://api.moonshot.cn/v1" },
  { id: "kimi-intl", label: "ai.kimiGlobal", protocol: "chat", endpoint: "https://api.moonshot.ai/v1" },
  { id: "glm-cn", label: "ai.glmChina", protocol: "chat", endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "glm-intl", label: "Z.ai", protocol: "chat", endpoint: "https://api.z.ai/api/paas/v4" },
  { id: "minimax", label: "MiniMax", protocol: "chat", endpoint: "https://api.minimax.io/v1" },
  { id: "doubao", label: "ai.doubao", protocol: "chat", endpoint: "https://ark.cn-beijing.volces.com/api/v3" },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "chat",
    endpoint: "https://openrouter.ai/api/v1",
    format: "schema",
  },
  { id: "siliconflow", label: "SiliconFlow", protocol: "chat", endpoint: "https://api.siliconflow.cn/v1" },
  { id: "ollama", label: "Ollama", protocol: "chat", endpoint: "http://127.0.0.1:11434/v1", local: true },
  { id: "lmstudio", label: "LM Studio", protocol: "chat", endpoint: "http://127.0.0.1:1234/v1", local: true },
  { id: "vllm", label: "vLLM", protocol: "chat", endpoint: "http://127.0.0.1:8000/v1", local: true },
  { id: "custom", label: "ai.customService", protocol: "chat", endpoint: "" },
];
export interface AiFailure {
  code:
    | "url"
    | "key"
    | "model"
    | "network"
    | "timeout"
    | "http"
    | "cancelled"
    | "invalidResponse"
    | "incomplete"
    | "refused"
    | "tooLarge"
    | "settings"
    | "storage"
    | "changed";
  status?: number;
}
export class AiError extends Error {
  constructor(readonly failure: AiFailure) {
    super(failure.code);
  }
}
export const aiFailure = (error: unknown): AiFailure =>
  error instanceof AiError
    ? error.failure
    : {
        code:
          error instanceof DOMException
            ? error.name === "AbortError"
              ? "cancelled"
              : ["QuotaExceededError", "InvalidStateError", "UnknownError"].includes(error.name)
                ? "storage"
                : "network"
            : "network",
      };
export interface AiProfile {
  revision?: number;
  id: string;
  preset: string;
  name: string;
  protocol: AiProtocol;
  endpoint: string;
  model: string;
  format: AiFormat;
  keyRequired: boolean;
  maxTokens: number;
  maxContextChars: number;
  timeoutSeconds: number;
  models?: readonly { id: string; name: string; vision?: boolean }[];
  probe?: { testedAt: string; model: string; ok: boolean; failure?: AiFailure };
}
export interface AiRoutes {
  edit?: { profileId: string; model: string };
  director?: { profileId: string; model: string };
  translate?: { profileId: string; model: string };
  vision?: { profileId: string; model: string };
}
export const AI_TASKS: readonly AiTask[] = ["edit", "director", "translate", "vision"];
export function profileFromPreset(id: string): AiProfile {
  const preset = AI_PRESETS.find((item) => item.id === id) ?? AI_PRESETS.at(-1)!;
  return {
    id: crypto.randomUUID(),
    preset: preset.id,
    name: preset.label,
    protocol: preset.protocol,
    endpoint: preset.endpoint,
    model: "",
    format: preset.format ?? "prompt",
    keyRequired: !preset.local,
    maxTokens: 4096,
    maxContextChars: 120_000,
    timeoutSeconds: 90,
  };
}
export function serviceUrl(profile: AiProfile, path: string): URL {
  let base: URL;
  try {
    base = new URL(profile.endpoint.trim().replace(/\/+$/u, "") + "/");
  } catch {
    throw new AiError({ code: "url" });
  }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new AiError({ code: "url" });
  return new URL(path, base);
}
