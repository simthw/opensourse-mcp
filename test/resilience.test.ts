/**
 * Deadline / cancellation / partial-result regression suite.
 *
 * All scenarios share one process (the same "session"): a long Retry-After, a
 * response body that stalls, a stuck backfill page, and a client cancel — each
 * followed by a plain single-source query that must complete normally.
 * Assertions cover total wall time, requests actually sent, partial results
 * and the per-source status taxonomy (ok / timeout / rate_limited / cancelled).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverAndScreen } from "../src/workflow.js";
import { clearCooldowns, fetchWithTimeout } from "../src/http.js";

process.env.LITERATURE_MCP_CACHE_TTL_MS = "0";

const originalFetch = globalThis.fetch;

function openAlexPage(count = 50, nextCursor?: string): Response {
  return new Response(
    JSON.stringify({
      meta: { count, next_cursor: nextCursor },
      results: [
        {
          id: "W1",
          display_name: "graph neural networks study",
          publication_year: 2024,
          cited_by_count: 5,
        },
      ],
    }),
    { status: 200 },
  );
}

function hanging(): Promise<Response> {
  return new Promise<Response>(() => {});
}

test("a long Retry-After becomes a shared cooldown instead of an early retry", async (t) => {
  clearCooldowns();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("rate limited", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "60" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearCooldowns();
  });

  const started = Date.now();
  const first = await discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex"], limit: 5 },
    { deadlineMs: 8000 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `expected a fast rate-limit answer, took ${elapsed}ms`);
  assert.equal(calls, 1, "a 60s Retry-After must not be retried early");
  assert.equal(first.sourceReports?.[0]?.status, "rate_limited");
  assert.match(first.sourceReports?.[0]?.note ?? "", /Retry-After|cooling/i);

  const second = await discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex"], limit: 5 },
    { deadlineMs: 8000 },
  );
  assert.equal(calls, 1, "a cooled-down scope must not be contacted at all");
  assert.equal(second.sourceReports?.[0]?.status, "rate_limited");
  assert.match(second.sourceReports?.[0]?.note ?? "", /cooling down/i);

  // After the cooldown is lifted the same query works again in the same session.
  clearCooldowns();
  globalThis.fetch = (async () => {
    calls += 1;
    return openAlexPage();
  }) as typeof fetch;
  const third = await discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex"], limit: 5 },
    { deadlineMs: 8000 },
  );
  assert.equal(third.sourceReports?.[0]?.status, "ok");
  assert.equal(third.returned, 1);
});

test("a response body that stalls is bounded by the per-attempt timeout, URL redacted", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as typeof fetch;

  const started = Date.now();
  await assert.rejects(
    () =>
      fetchWithTimeout("https://slow.test/body?api_key=SECRET123", {
        cacheTtlMs: 0,
        timeoutMs: 400,
        retries: 0,
      }),
    (error: Error & { kind?: string }) => {
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /timed out after 400ms/);
      assert.ok(error.message.includes("https://slow.test/body"), error.message);
      assert.ok(!error.message.includes("SECRET123"), "API keys must be redacted from errors");
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "a stalled body must not hold the call open");
});

test("a hanging source yields partial results and the next query completes normally", async (t) => {
  clearCooldowns();
  let openAlexCalls = 0;
  let slowCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("api.openalex.org")) {
      openAlexCalls += 1;
      return openAlexPage();
    }
    slowCalls += 1;
    return hanging();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearCooldowns();
  });

  const started = Date.now();
  const result = await discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex", "semantic_scholar"], limit: 5, perSourceLimit: 5 },
    { deadlineMs: 3000 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4500, `partial results must arrive near the deadline, took ${elapsed}ms`);
  assert.equal(result.returned, 1, "the fast source's papers must survive");
  const reports = Object.fromEntries((result.sourceReports ?? []).map((report) => [report.source, report]));
  assert.equal(reports.openalex.status, "ok");
  assert.equal(reports.semantic_scholar.status, "timeout");
  assert.ok(
    result.warnings.some((warning) => /partial results/.test(warning)),
    JSON.stringify(result.warnings),
  );
  assert.ok(result.timing?.expired, "the timing block must show the deadline was hit");
  assert.ok(slowCalls <= 2, `the dead call must stop consuming quota, sent ${slowCalls} requests`);

  const next = await discoverAndScreen({ topic: "graph neural networks", sources: ["openalex"], limit: 5 });
  assert.equal(next.sourceReports?.[0]?.status, "ok");
  assert.equal(next.returned, 1);
});

test("a stuck backfill page returns the pages already fetched", async (t) => {
  clearCooldowns();
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor");
    if (cursor === "*" || cursor === null) return openAlexPage(50, "c2");
    return hanging();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearCooldowns();
  });

  const started = Date.now();
  const result = await discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex"], limit: 10, perSourceLimit: 1 },
    { deadlineMs: 3000 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4500, `took ${elapsed}ms`);
  assert.equal(result.returned, 1);
  const report = result.sourceReports?.[0];
  assert.equal(report?.pages, 1, "the fetched page is kept");
  assert.equal(report?.retrieved, 1);
  assert.equal(report?.status, "timeout");
  assert.ok(result.warnings.some((warning) => /backfill/.test(warning)), JSON.stringify(result.warnings));

  globalThis.fetch = (async () => openAlexPage()) as typeof fetch;
  const next = await discoverAndScreen({ topic: "graph neural networks", sources: ["openalex"], limit: 5 });
  assert.equal(next.sourceReports?.[0]?.status, "ok");
});

test("a cancelled call stops issuing requests immediately", async (t) => {
  clearCooldowns();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return hanging();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearCooldowns();
  });

  const controller = new AbortController();
  const started = Date.now();
  const pending = discoverAndScreen(
    { topic: "graph neural networks", sources: ["openalex"], limit: 5 },
    { signal: controller.signal, deadlineMs: 20000 },
  );
  setTimeout(() => controller.abort(), 150);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `cancel must unwind fast, took ${elapsed}ms`);
  assert.equal(calls, 1, "a cancelled call must not retry");
  assert.equal(result.sourceReports?.[0]?.status, "cancelled");
  assert.equal(result.returned, 0);

  globalThis.fetch = (async () => {
    calls += 1;
    return openAlexPage();
  }) as typeof fetch;
  const next = await discoverAndScreen({ topic: "graph neural networks", sources: ["openalex"], limit: 5 });
  assert.equal(next.sourceReports?.[0]?.status, "ok");
  assert.equal(next.returned, 1, "the next query in the same session completes normally");
});
