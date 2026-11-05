import { AiError, serviceUrl, type AiProfile } from "./services";
import { readAiConnection } from "./storage";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
async function request(profile: AiProfile, path: string, signal: AbortSignal, body?: unknown): Promise<ObjectValue> {
  const connection = await readAiConnection(profile.id);
  if (
    !connection.profile ||
    connection.profile.revision !== profile.revision ||
    connection.profile.endpoint !== profile.endpoint ||
    connection.profile.protocol !== profile.protocol
  )
    throw new AiError({ code: "changed" });
  const key = connection.key;
  if (profile.keyRequired && !key && !(body === undefined && profile.preset === "openrouter"))
    throw new AiError({ code: "key" });
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  };
  if (profile.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    if (key) headers["x-api-key"] = key;
  } else if (profile.protocol === "gemini") {
    if (key) headers["x-goog-api-key"] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;
  const timer = AbortSignal.timeout(profile.timeoutSeconds * 1000),
    lifetime = AbortSignal.any([signal, timer]);
  try {
    const response = await fetch(serviceUrl(profile, path), {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: lifetime,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiError({ code: "http", status: response.status });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AiError({ code: "invalidResponse" });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16 * 1024 ** 2) throw new AiError({ code: "tooLarge" });
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return object(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new AiError({ code: "invalidResponse" });
    }
  } catch (error) {
    if (signal.aborted) throw new AiError({ code: "cancelled" });
    if (timer.aborted) throw new AiError({ code: "timeout" });
    if (error instanceof AiError) throw error;
    throw new AiError({ code: "network" });
  }
}
export async function discoverAiModels(profile: AiProfile, signal: AbortSignal) {
  const rows: unknown[] = [],
    cursors = new Set<string>();
  let path = "models";
  for (;;) {
    const response = await request(profile, path, signal);
    const page = profile.protocol === "gemini" ? response.models : response.data;
    if (!Array.isArray(page)) throw new AiError({ code: "invalidResponse" });
    rows.push(...page);
    if (rows.length > 10_000) throw new AiError({ code: "tooLarge" });
    const cursor =
      profile.protocol === "gemini"
        ? response.nextPageToken
        : profile.protocol === "anthropic" && response.has_more
          ? response.last_id
          : undefined;
    if (!cursor) break;
    if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 100)
      throw new AiError({ code: "invalidResponse" });
    cursors.add(cursor);
    path = `models?${new URLSearchParams({ [profile.protocol === "gemini" ? "pageToken" : "after_id"]: cursor })}`;
  }
  const models = rows
    .map(object)
    .filter(
      (row) =>
        profile.protocol !== "gemini" ||
        !Array.isArray(row.supportedGenerationMethods) ||
        row.supportedGenerationMethods.includes("generateContent"),
    )
    .filter((row) => typeof (row.id ?? row.name) === "string")
    .map((row) => {
      const id = String(row.id ?? row.name).replace(/^models\//u, "");
      const modalities = object(row.architecture).input_modalities;
      return {
        id,
        name: String(row.displayName ?? row.display_name ?? row.name ?? id),
        ...(Array.isArray(modalities) ? { vision: modalities.includes("image") } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
export interface AiCompletion {
  system: string;
  prompt: string;
  schema: ObjectValue;
  image?: string;
  model?: string;
  maxTokens?: number;
}
export async function completeAi(profile: AiProfile, input: AiCompletion, signal: AbortSignal): Promise<string> {
  const model = (input.model || profile.model).replace(/^models\//u, "");
  if (!model) throw new AiError({ code: "model" });
  const maxTokens = input.maxTokens ?? profile.maxTokens;
  const schema = { name: "story_edit_plan", strict: true, schema: input.schema };
  let path: string, body: ObjectValue;
  const system = input.system + "\nReturn only a JSON object matching this schema: " + JSON.stringify(input.schema);
  if (system.length + input.prompt.length > profile.maxContextChars) throw new AiError({ code: "tooLarge" });
  if (profile.protocol === "responses") {
    path = "responses";
    body = {
      model,
      instructions: system,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: input.prompt },
            ...(input.image ? [{ type: "input_image", image_url: input.image }] : []),
          ],
        },
      ],
      max_output_tokens: maxTokens,
      store: false,
      ...(profile.format === "prompt"
        ? {}
        : {
            text: {
              format: profile.format === "schema" ? { type: "json_schema", ...schema } : { type: "json_object" },
            },
          }),
    };
  } else if (profile.protocol === "anthropic") {
    path = "messages";
    const image = input.image?.match(/^data:([^;]+);base64,(.+)$/u);
    body = {
      model,
      system,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            ...(image ? [{ type: "image", source: { type: "base64", media_type: image[1], data: image[2] } }] : []),
            { type: "text", text: input.prompt },
          ],
        },
      ],
      ...(profile.format === "schema"
        ? { output_config: { format: { type: "json_schema", schema: input.schema } } }
        : {}),
    };
  } else if (profile.protocol === "gemini") {
    path = `models/${encodeURIComponent(model)}:generateContent`;
    const image = input.image?.match(/^data:([^;]+);base64,(.+)$/u);
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [{ text: input.prompt }, ...(image ? [{ inlineData: { mimeType: image[1], data: image[2] } }] : [])],
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(profile.format === "prompt"
          ? {}
          : {
              responseMimeType: "application/json",
              ...(profile.format === "schema" ? { responseJsonSchema: input.schema } : {}),
            }),
      },
    };
  } else {
    path = "chat/completions";
    body = {
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: input.image
            ? [
                { type: "text", text: input.prompt },
                { type: "image_url", image_url: { url: input.image } },
              ]
            : input.prompt,
        },
      ],
      max_tokens: maxTokens,
      ...(profile.format === "prompt"
        ? {}
        : {
            response_format:
              profile.format === "schema" ? { type: "json_schema", json_schema: schema } : { type: "json_object" },
          }),
    };
  }
  const value = await request(profile, path, signal, body);
  let text = "";
  if (profile.protocol === "responses") {
    if (value.status === "incomplete" || value.incomplete_details) throw new AiError({ code: "incomplete" });
    if (value.status === "failed" || value.error) throw new AiError({ code: "invalidResponse" });
    const content = (Array.isArray(value.output) ? value.output : [])
      .flatMap((item) => (Array.isArray(object(item).content) ? (object(item).content as unknown[]) : []))
      .map(object);
    if (content.some((part) => part.type === "refusal")) throw new AiError({ code: "refused" });
    text = content
      .filter((part) => part.type === "output_text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
  } else if (profile.protocol === "anthropic") {
    if (value.stop_reason === "max_tokens") throw new AiError({ code: "incomplete" });
    text = (Array.isArray(value.content) ? value.content : [])
      .map(object)
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
  } else if (profile.protocol === "gemini") {
    const candidate = object(Array.isArray(value.candidates) ? value.candidates[0] : undefined);
    if (candidate.finishReason === "MAX_TOKENS") throw new AiError({ code: "incomplete" });
    if (object(value.promptFeedback).blockReason) throw new AiError({ code: "refused" });
    text = (Array.isArray(object(candidate.content).parts) ? (object(candidate.content).parts as unknown[]) : [])
      .map(object)
      .filter((part) => !part.thought)
      .map((part) => String(part.text ?? ""))
      .join("\n");
  } else {
    const choice = object(Array.isArray(value.choices) ? value.choices[0] : undefined),
      message = object(choice.message);
    if (choice.finish_reason === "length") throw new AiError({ code: "incomplete" });
    if (message.refusal) throw new AiError({ code: "refused" });
    text = typeof message.content === "string" ? message.content : "";
  }
  if (!text.trim()) throw new AiError({ code: "invalidResponse" });
  return text
    .trim()
    .replace(/^```(?:json)?\s*\n/iu, "")
    .replace(/\n```\s*$/u, "");
}
