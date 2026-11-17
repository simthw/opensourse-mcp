/**
 * One search call has a single wall-clock budget, measured against the
 * client's real tool-call timeout (DSH default: 60,000ms per tools/call).
 * The server finishes early enough that the merged result still reaches the
 * client: `DEFAULT_DEADLINE_MS` leaves headroom for merge + screening +
 * formatting + the response write.
 */
export const DEFAULT_DEADLINE_MS = 50_000;

/** Total per-call budget, overridable via LITERATURE_MCP_DEADLINE_MS. */
export function configuredDeadlineMs(): number {
  const raw = Number(process.env.LITERATURE_MCP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_DEADLINE_MS;
}

/** Per-source budget: one slow source cannot starve the paging of others. */
export function configuredSourceBudgetMs(): number {
  const raw = Number(process.env.LITERATURE_MCP_SOURCE_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 30_000;
}
/** Time kept for merging, screening, formatting and serialising the reply. */
export const RESPONSE_RESERVE_MS = 5_000;

export type AbortReason = "deadline" | "cancelled";

export class DeadlineError extends Error {
  readonly kind: "timeout" | "cancelled";
  constructor(reason: AbortReason) {
    super(reason === "deadline" ? "deadline exceeded" : "cancelled by client");
    this.name = "DeadlineError";
    this.kind = reason === "deadline" ? "timeout" : "cancelled";
  }
}

export function isAbortLike(error: unknown): boolean {
  return (
    error instanceof DeadlineError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

/**
 * Wall-clock budget for one MCP tool call.
 *
 * Queuing, backoff, HTTP requests, response-body reads and paging all draw
 * from the same remaining time. The deadline aborts `signal`, so anything
 * listening (fetch, sleeps, throttle queues) unwinds immediately instead of
 * continuing to consume upstream quota after the caller is gone.
 */
export class Deadline {
  readonly expiresAt: number;
  readonly startedAt = Date.now();
  readonly totalMs: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private reason: AbortReason | undefined;
  private readonly detach: Array<() => void> = [];

  constructor(totalMs: number, parent?: AbortSignal) {
    this.totalMs = Math.max(1, totalMs);
    this.expiresAt = this.startedAt + this.totalMs;
    this.timer = setTimeout(() => this.abort("deadline"), this.totalMs);
    // A finished tool call must not keep the process (or the test runner)
    // alive: the timer only matters while the call is still running.
    (this.timer as { unref?: () => void }).unref?.();
    if (parent) {
      if (parent.aborted) {
        this.abort("cancelled");
      } else {
        const onAbort = () => this.abort("cancelled");
        parent.addEventListener("abort", onAbort, { once: true });
        this.detach.push(() => parent.removeEventListener("abort", onAbort));
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get abortReason(): AbortReason | undefined {
    return this.reason;
  }

  /** Milliseconds left before the deadline fires (0 once it has). */
  remaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  /**
   * Time usable for work. The response reserve scales down with the budget:
   * a 3s budget keeps 0.5s for the reply, the 50s default keeps the full 5s.
   */
  remainingForWork(): number {
    const reserve = Math.min(RESPONSE_RESERVE_MS, Math.max(500, Math.floor(this.totalMs * 0.1)));
    return Math.max(0, this.remaining() - reserve);
  }

  expired(): boolean {
    return this.reason !== undefined || this.remaining() === 0;
  }

  throwIfExpired(): void {
    if (this.reason) throw new DeadlineError(this.reason);
    if (this.remaining() === 0) throw new DeadlineError("deadline");
  }

  /**
   * Abort-aware sleep. Rejects with a DeadlineError when the deadline fires or
   * the caller cancels, so backoff waits never outlive the request.
   */
  sleep(ms: number): Promise<void> {
    return sleep(ms, this.signal, () => new DeadlineError(this.reason ?? "deadline"));
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  private abort(reason: AbortReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort(new DeadlineError(reason));
  }
}

/**
 * What a provider needs to know about the enclosing tool call: how much time
 * is left and when to stop. Passed as the last argument of every search
 * function so queuing, backoff, requests, body reads and paging all draw from
 * the same budget and abort together.
 */
export interface RequestCtx {
  deadline?: Deadline;
  logTag?: string;
}

/**
 * Fetch options for one provider request under a call budget: the parent
 * signal (so a cancel aborts the fetch), the remaining budget (so a long
 * Retry-After cannot outlive the call), a per-attempt timeout capped by the
 * remaining time, and a log tag linking the request to its tool call.
 */
export function ctxOptions(
  ctx: RequestCtx | undefined,
  base: { timeoutMs?: number; signal?: AbortSignal } = {},
): { signal?: AbortSignal; budgetMs?: number; logTag?: string; timeoutMs?: number } {
  const remaining = ctx?.deadline?.remainingForWork();
  return {
    signal: ctx?.deadline?.signal ?? base.signal,
    budgetMs: remaining,
    logTag: ctx?.logTag,
    timeoutMs: remaining !== undefined ? Math.min(base.timeoutMs ?? 15000, remaining) : base.timeoutMs,
  };
}

/**
 * Sleep that stops early when `signal` aborts. `onAbort` builds the error so
 * callers can classify the interruption (deadline vs. client cancel).
 */
export function sleep(ms: number, signal?: AbortSignal, onAbort?: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(onAbort ? onAbort() : new DeadlineError("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbortHandler);
      resolve();
    }, Math.max(0, ms));
    const onAbortHandler = () => {
      clearTimeout(timer);
      reject(onAbort ? onAbort() : new DeadlineError("cancelled"));
    };
    signal?.addEventListener("abort", onAbortHandler, { once: true });
  });
}
