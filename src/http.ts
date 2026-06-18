const DEFAULT_TIMEOUT_MS = 15000;

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * fetch with an AbortController-based timeout so a slow or unresponsive
 * upstream API cannot hang an MCP tool call indefinitely.
 */
export async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
