/** Stop waiting on a host operation when its caller or editor context closes.
 * Late results are consumed; callers still fence mutations at their commit boundary.
 */
export function abortableOperation<T>(
  run: () => Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const active = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
    for (const signal of active) signal.throwIfAborted();
    let settled = false;
    const listeners = active.map((signal) => ({ signal, abort: () => finish(() => reject(signal.reason)) }));
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      for (const { signal, abort } of listeners) signal.removeEventListener("abort", abort);
      settle();
    };
    for (const { signal, abort } of listeners) signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        for (const signal of active) signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}
