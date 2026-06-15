export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  },
): Promise<T> {
  let delayMs = options.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts) break;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, options.maxDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
