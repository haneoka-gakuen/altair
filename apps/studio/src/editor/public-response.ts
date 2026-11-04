import { abortableOperation } from "./abortable-operation";

export interface PublicResponseOptions {
  readonly label: string;
  readonly maxBytes: number;
  readonly signals?: readonly (AbortSignal | undefined)[];
  readonly json?: boolean;
  /** Header/body inactivity deadline; reset after each received chunk. */
  readonly timeoutMs?: number;
}
/** Own the fetch signal until its response body has been read or canceled. */
export async function readPublicResponse(url: string, options: PublicResponseOptions): Promise<Uint8Array> {
  const controller = new AbortController(),
    signals = [...new Set((options.signals ?? []).filter((signal): signal is AbortSignal => !!signal))];
  for (const signal of signals) signal.throwIfAborted();
  const listeners = signals.map((signal) => ({ signal, abort: () => controller.abort(signal.reason) }));
  for (const { signal, abort } of listeners) signal.addEventListener("abort", abort, { once: true });
  let response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const resetDeadline = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException(`${options.label} response timed out`, "TimeoutError")),
      options.timeoutMs ?? 30_000,
    );
  };
  const cancelResponse = async (value: Response) => {
    try {
      await value.body?.cancel();
    } catch {
      /* Preserve the original status/validation error. */
    }
  };
  try {
    resetDeadline();
    for (let attempt = 0; ; attempt++) {
      const pending = fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      void pending
        .then((value) => {
          if (controller.signal.aborted && response !== value) return cancelResponse(value);
        })
        .catch(() => undefined);
      response = await abortableOperation(() => pending, [controller.signal]);
      if (attempt >= 2 || ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      await cancelResponse(response);
      const seconds = Number(response.headers.get("retry-after"));
      const delay = seconds > 0 ? Math.min(seconds * 1000, 3000) : 250 * 2 ** attempt;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortableOperation(
          () =>
            new Promise<void>((resolve) => {
              retryTimer = setTimeout(resolve, delay);
            }),
          [controller.signal],
        );
      } finally {
        clearTimeout(retryTimer);
      }
      resetDeadline();
    }
    controller.signal.throwIfAborted();
    if (!response.ok) throw new Error(`${options.label} HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))
        throw new Error(`${options.label} response length is invalid`);
      if (Number(declared) > options.maxBytes) throw new Error(`${options.label} exceeds its byte limit`);
    }
    if (
      options.json &&
      !/^application\/(?:[a-z\d!#$&^_.-]+\+)?json$/iu.test(
        (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim(),
      )
    )
      throw new Error(`${options.label} is not JSON`);
    reader = response.body?.getReader();
    if (!reader) throw new Error(`${options.label} response is empty`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      resetDeadline();
      const { value, done } = await abortableOperation(() => reader!.read(), [controller.signal]);
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) throw new Error(`${options.label} exceeds its byte limit`);
      chunks.push(Uint8Array.from(value));
    }
    controller.signal.throwIfAborted();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    // Validation can fail before a reader is acquired; that body still belongs to this request.
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* Best-effort stream cleanup. */
      } finally {
        reader.releaseLock();
      }
    } else if (response) await cancelResponse(response);
    if (timer) clearTimeout(timer);
    for (const { signal, abort } of listeners) signal.removeEventListener("abort", abort);
  }
}
