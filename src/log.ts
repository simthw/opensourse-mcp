/**
 * Structured diagnostics on stderr (stdout carries the MCP protocol).
 *
 * Every line is one JSON object with the request id, so a slow or failed call
 * can be reconstructed: which source, which page, how long it queued, what the
 * upstream said (status, Retry-After) and why the attempt ended.
 */
let counter = 0;

export function newRequestId(): string {
  counter += 1;
  return `req-${process.pid}-${counter}-${Date.now().toString(36)}`;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // Production logs go to stderr (stdout carries MCP). Quiet in tests unless
  // a test explicitly clears LITERATURE_MCP_QUIET.
  if (process.env.LITERATURE_MCP_QUIET || process.env.NODE_TEST_CONTEXT) return;
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields });
  process.stderr.write(line + "\n");
}

/**
 * Errors may embed request URLs; upstream query strings can carry API keys
 * (OpenAlex sends `api_key` as a query parameter). Keep origin + path only.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
