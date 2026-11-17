import { createHash } from "node:crypto";
import { logEvent, safeUrl } from "./log.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
/**
 * A Retry-After beyond this is a quota window, not a burst hiccup: waiting it
 * out inside one tool call would blow the client's timeout. The wait becomes a
 * shared cooldown instead (see setCooldown).
 */
const LONG_RETRY_AFTER_MS = 15_000;
/** Upper bound on queued callers per upstream scope; beyond that fail fast. */
const MAX_QUEUE_DEPTH = 32;

export type RequestFailure = "timeout" | "rate_limited" | "upstream_error" | "cancelled";

/** Typed transport failure so callers can report WHY a source failed. */
export class HttpRequestError extends Error {
  readonly kind: RequestFailure;
  readonly status?: number;
  /** Final errors stop the retry loop (quota windows, cancels, exhaustion). */
  readonly final: boolean;
  constructor(kind: RequestFailure, message: string, status?: number, final = false) {
    super(message);
    this.name = "HttpRequestError";
    this.kind = kind;
    this.status = status;
    this.final = final;
  }
}

/** Classify an error thrown anywhere below the tool handlers. */
export function classifyFailure(error: unknown): RequestFailure {
  if (error instanceof HttpRequestError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled by client/i.test(message)) return "cancelled";
  if (/timed out|deadline exceeded/i.test(message)) return "timeout";
  if (/429|rate limited|cooling down/i.test(message)) return "rate_limited";
  return "upstream_error";
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /**
   * Floor for the retry delay (after the first attempt), for providers with
   * per-request rate policies such as arXiv's 1 request / 3 seconds.
   */
  minRetryDelayMs?: number;
  /**
   * Minimum spacing between requests to the same host, in milliseconds.
   * Concurrent callers to a throttled host queue instead of bursting.
   */
  throttleMs?: number;
  cacheTtlMs?: number;
  /**
   * Remaining work budget of the current tool call. A Retry-After longer than
   * this (or than LONG_RETRY_AFTER_MS) is turned into a shared cooldown
   * instead of being slept through.
   */
  budgetMs?: number;
  /** Label for stderr diagnostics (request id, source, page). */
  logTag?: string;
}

interface CachedResponse {
  expiresAt: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

const responseCache = new Map<string, CachedResponse>();

// ---- shared cooldowns ------------------------------------------------------

const cooldownUntil = new Map<string, number>();

function cooldownKey(url: string, init: RequestInit): string {
  return scopeKey(url, init);
}

function setCooldown(key: string, ms: number): void {
  cooldownUntil.set(key, Date.now() + Math.max(0, ms));
}

export function getCooldownRemaining(key: string): number {
  const until = cooldownUntil.get(key) ?? 0;
  return Math.max(0, until - Date.now());
}

export function clearCooldowns(): void {
  cooldownUntil.clear();
}

/** Active cooldowns (scope + remaining ms), for health reporting. */
export function activeCooldowns(): Array<{ scope: string; remainingMs: number }> {
  const now = Date.now();
  return [...cooldownUntil.entries()]
    .map(([scope, until]) => ({ scope, remainingMs: Math.max(0, until - now) }))
    .filter((entry) => entry.remainingMs > 0);
}

/**
 * fetch with:
 * - an AbortController timeout that covers the RESPONSE BODY too (a server can
 *   send headers and then stall; the old timer ended at the headers),
 * - abort propagation from the caller (MCP cancel / tool-call deadline), so a
 *   dead call stops consuming upstream quota immediately,
 * - bounded retries with Retry-After honoured, and long Retry-After values
 *   converted to a shared per-scope cooldown instead of being slept through.
 */
export async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    minRetryDelayMs,
    throttleMs,
    cacheTtlMs = configuredCacheTtlMs(),
    budgetMs,
    logTag,
    signal: parentSignalRaw,
    ...init
  } = options;
  const parentSignal = parentSignalRaw ?? undefined;
  const method = init.method?.toUpperCase() ?? "GET";
  const cacheKey = method === "GET" && cacheTtlMs > 0 ? buildCacheKey(url, init) : undefined;
  if (cacheKey) {
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, cached);
      return responseFromCache(cached);
    }
    if (cached) responseCache.delete(cacheKey);
  }

  // A scope in cooldown is not asked again: the upstream already told us when
  // it will accept requests, and hitting it early only burns quota.
  const scope = scopeKey(url, init);
  const cooling = getCooldownRemaining(scope);
  if (cooling > 0) {
    logEvent("http.cooldown_skip", { logTag, host: hostOf(url), coolingMs: cooling });
    throw new HttpRequestError(
      "rate_limited",
      `cooling down for ${Math.ceil(cooling / 1000)}s more (upstream Retry-After)`,
      429,
      true,
    );
  }

  let lastError: unknown;
  let lastStatus: number | undefined;
  let lastStatusText: string | undefined;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const queuedAt = Date.now();
    await awaitThrottleSlot(scope, throttleMs, parentSignal);
    lastStatus = undefined;
    lastStatusText = undefined;
    try {
      const response = await fetchOnce(url, init, timeoutMs, parentSignal);
      logEvent("http.response", {
        logTag,
        host: hostOf(url),
        status: response.status,
        queueMs: Date.now() - queuedAt,
        attempt,
      });
      if (response.ok) {
        if (cacheKey) return cacheAndClone(cacheKey, response, cacheTtlMs);
        return response;
      }

      lastStatus = response.status;
      lastStatusText = response.statusText;
      lastRetryAfter = response.headers.get("retry-after");
      if (!isRetryableStatus(response.status)) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(lastRetryAfter);
      const waitMs = retryAfterMs ?? delayForAttempt(attempt, retryDelayMs, minRetryDelayMs ?? throttleMs);
      const budget = budgetMs ?? Number.POSITIVE_INFINITY;
      const isQuotaWindow = retryAfterMs !== undefined && (retryAfterMs > LONG_RETRY_AFTER_MS || retryAfterMs > budget);

      if (isQuotaWindow) {
        // The upstream asked for a wait we cannot afford inside this call:
        // record the shared cooldown and report the rate limit at once.
        setCooldown(scope, retryAfterMs!);
        logEvent("http.cooldown_set", {
          logTag,
          host: hostOf(url),
          retryAfterMs,
          reason: "retry-after exceeds remaining budget",
        });
        throw new HttpRequestError(
          "rate_limited",
          `429 ${lastStatusText ?? ""}`.trim() + ` (Retry-After ${Math.ceil(retryAfterMs! / 1000)}s; cooling down)`,
          429,
          true,
        );
      }
      if (attempt === retries) break;
      if (waitMs > budget) {
        setCooldown(scope, waitMs);
        throw new HttpRequestError(
          "rate_limited",
          `429 ${lastStatusText ?? ""}`.trim() + " (rate limited; no budget left to retry)",
          429,
          true,
        );
      }
      await sleepAbortable(waitMs, parentSignal);
    } catch (error) {
      // Quota windows, cancels and exhausted retries stop here; plain transport
      // failures (timeouts, resets, DNS) fall through to the backoff below.
      if (error instanceof HttpRequestError && error.final) throw error;
      lastError = error;
      if (attempt === retries) break;
      const waitMs = delayForAttempt(attempt, retryDelayMs, minRetryDelayMs);
      if (waitMs > (budgetMs ?? Number.POSITIVE_INFINITY)) break;
      try {
        await sleepAbortable(waitMs, parentSignal);
      } catch (sleepError) {
        lastError = sleepError;
        break;
      }
    }
  }

  if (lastStatus !== undefined) {
    if (lastStatus === 429) {
      const retryAfterMs = parseRetryAfterMs(lastRetryAfter);
      if (retryAfterMs !== undefined) setCooldown(scope, retryAfterMs);
    }
    const suffix = lastStatus === 429 ? " (rate limited; retries exhausted)" : " (retries exhausted)";
    const kind: RequestFailure = lastStatus === 429 ? "rate_limited" : "upstream_error";
    throw new HttpRequestError(kind, `${lastStatus} ${lastStatusText ?? ""}`.trim() + suffix, lastStatus, true);
  }
  if (lastError instanceof HttpRequestError) throw lastError;
  throw new HttpRequestError(
    classifyFailure(lastError),
    lastError instanceof Error ? lastError.message : String(lastError),
    undefined,
    true,
  );
}

/**
 * One attempt whose timeout covers headers AND the response body: a server
 * that answers the request and then stalls on the body must not keep the call
 * (and its upstream quota) alive indefinitely.
 */
async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  const failWith = (reason: unknown): Error => {
    if (parentSignal?.aborted) {
      return abortError(parentSignal);
    }
    if (timedOut) {
      // The per-attempt timeout is transient: the caller may retry with the
      // remaining budget. The URL is redacted (it can carry an API key).
      return new HttpRequestError("timeout", `Request timed out after ${timeoutMs}ms: ${safeUrl(url)}`);
    }
    // Plain transport failure (reset, DNS, mock throw): surface as-is so the
    // retry loop can back off and try again.
    return reason instanceof Error ? reason : new Error(String(reason));
  };

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) throw failWith(parentSignal.reason);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    // Race the request itself against the abort signal as well: a mocked or
    // wedged transport that ignores the signal must still stop consuming the
    // call's budget the moment the deadline fires or the client cancels.
    const response = await new Promise<Response>((resolve, reject) => {
      const request = fetch(url, { ...init, signal: controller.signal });
      const onAbort = () => reject(failWith(undefined));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      request.then(
        (res) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (error) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(failWith(error));
        },
      );
    });
    // Race the body read against the abort signal: a server that sends
    // headers and then stalls on the body must not hold the call open
    // (real fetch bodies abort with the signal; this also covers the case
    // where the body simply never settles).
    const body = await new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(failWith(undefined));
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      response.text().then(
        (text) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
        (error) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(failWith(error));
        },
      );
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    throw error instanceof HttpRequestError ? error : failWith(error);
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Per-scope request pacing with a bounded queue. Callers are served one at a
 * time; each caller releases its slot in `finally`, so an aborted waiter never
 * blocks the queue behind it.
 */
const scopeNextSlot = new Map<string, number>();
const scopeQueueTail = new Map<string, Promise<void>>();
const scopeQueueDepth = new Map<string, number>();

async function awaitThrottleSlot(scope: string, spacing?: number, signal?: AbortSignal): Promise<void> {
  if (!spacing || spacing <= 0) return;
  const depth = scopeQueueDepth.get(scope) ?? 0;
  if (depth >= MAX_QUEUE_DEPTH) {
    throw new HttpRequestError("rate_limited", `too many queued requests for ${scope}`, undefined, true);
  }
  scopeQueueDepth.set(scope, depth + 1);

  const previous = scopeQueueTail.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  scopeQueueTail.set(
    scope,
    previous.then(() => mine),
  );

  try {
    await raceAbort(previous, signal);
    const wait = Math.max(0, (scopeNextSlot.get(scope) ?? 0) - Date.now());
    if (wait > 0) await sleepAbortable(wait, signal);
    scopeNextSlot.set(scope, Date.now() + spacing);
  } finally {
    release();
    const remaining = (scopeQueueDepth.get(scope) ?? 1) - 1;
    if (remaining <= 0) {
      scopeQueueDepth.delete(scope);
      scopeNextSlot.delete(scope);
    } else {
      scopeQueueDepth.set(scope, remaining);
    }
  }
}

/**
 * Abort failures carry the reason: a client cancel and a tool-call deadline
 * are different report statuses (cancelled vs timeout), and the sleep/queue
 * helpers must not flatten one into the other.
 */
function abortError(signal?: AbortSignal): HttpRequestError {
  const reason = (signal?.reason ?? {}) as { kind?: string; message?: string };
  if (reason.kind === "cancelled" || /cancel/i.test(reason.message ?? "")) {
    return new HttpRequestError("cancelled", "cancelled by client", undefined, true);
  }
  return new HttpRequestError("timeout", "deadline exceeded", undefined, true);
}

function raceAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function scopeKey(url: string, init: RequestInit): string {
  const headers = new Headers(init.headers);
  const parts: string[] = [];
  headers.forEach((value, key) => parts.push(`${key}=${value}`));
  const signature =
    parts.length > 0
      ? createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
      : "none";
  return `${hostOf(url)} headers:${signature}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function configuredCacheTtlMs(): number {
  const raw = process.env.LITERATURE_MCP_CACHE_TTL_MS;
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

/**
 * Cache key includes the FULL value of every request header (hashed), so two
 * calls with different API keys no longer collide under the same entry.
 */
function buildCacheKey(url: string, init: RequestInit): string {
  return `GET ${url} headers:${scopeKey(url, init).split(" headers:")[1]}`;
}

async function cacheAndClone(cacheKey: string, response: Response, cacheTtlMs: number): Promise<Response> {
  const body = await response.text();
  const cached = {
    expiresAt: Date.now() + cacheTtlMs,
    status: response.status,
    statusText: response.statusText,
    headers: headersToEntries(response.headers),
    body,
  };
  responseCache.set(cacheKey, cached);
  evictOldest();
  return responseFromCache(cached);
}

/** Bounded cache: evict least-recently-used entries beyond the capacity. */
function evictOldest(): void {
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

function responseFromCache(cached: CachedResponse): Response {
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function headersToEntries(headers: Headers): [string, string][] {
  const entries: [string, string][] = [];
  headers.forEach((value, key) => entries.push([key, value]));
  return entries;
}

/**
 * Wait before a retry attempt. A server-supplied Retry-After is authoritative;
 * otherwise exponential backoff with jitter, floored at `minDelayMs` for
 * providers with strict rate policies (e.g. arXiv's 1 request / 3 seconds).
 */
function delayForAttempt(attempt: number, baseDelayMs: number, minDelayMs?: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.min(250, baseDelayMs));
  return Math.max(minDelayMs ?? 0, Math.min(exponential + jitter, MAX_RETRY_DELAY_MS));
}

function parseRetryAfterMs(value?: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  return undefined;
}
