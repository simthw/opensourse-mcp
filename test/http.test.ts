import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithTimeout } from "../src/http.js";

const originalFetch = globalThis.fetch;

test("fetchWithTimeout retries retryable status codes", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503, statusText: "Service Unavailable" });
    return new Response("ok", { status: 200, statusText: "OK" });
  };

  const response = await fetchWithTimeout("https://example.test/retry", {
    cacheTtlMs: 0,
    retryDelayMs: 0,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2);
});

test("fetchWithTimeout returns cached GET responses", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`body-${calls}`, { status: 200, statusText: "OK" });
  };

  const first = await fetchWithTimeout("https://example.test/cache", {
    cacheTtlMs: 1000,
  });
  const second = await fetchWithTimeout("https://example.test/cache", {
    cacheTtlMs: 1000,
  });

  assert.equal(await first.text(), "body-1");
  assert.equal(await second.text(), "body-1");
  assert.equal(calls, 1);
});

test("a persistent 429 reports the status instead of a timeout", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
  };

  await assert.rejects(
    () =>
      fetchWithTimeout("https://example.test/limited", {
        cacheTtlMs: 0,
        retryDelayMs: 0,
        retries: 1,
      }),
    /429/,
  );
  assert.equal(calls, 2, "a 429 is retried (burst limits are transient)");
});

test("a transport failure (timeout/reset) is retried, not surfaced immediately", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Request timed out after 15000ms: https://example.test/slow");
    return new Response("ok", { status: 200, statusText: "OK" });
  };

  const response = await fetchWithTimeout("https://example.test/slow", {
    cacheTtlMs: 0,
    retryDelayMs: 0,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2, "a timeout is transient and must be retried");
});

test("a transient 429 recovers on retry", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("limited", { status: 429, statusText: "Too Many Requests" });
    return new Response("ok", { status: 200, statusText: "OK" });
  };

  const response = await fetchWithTimeout("https://example.test/limited-retry", {
    cacheTtlMs: 0,
    retryDelayMs: 0,
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("throttled requests to one host are spaced out", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`body-${calls}`, { status: 200, statusText: "OK" });
  };

  const started = Date.now();
  await Promise.all(
    [0, 1, 2].map((i) =>
      fetchWithTimeout(`https://throttled.test/item-${i}`, { cacheTtlMs: 0, throttleMs: 80 }),
    ),
  );
  const elapsed = Date.now() - started;

  assert.equal(calls, 3);
  assert.ok(elapsed >= 140, `expected >=140ms of spacing, got ${elapsed}ms`);
});

test("different API keys no longer share a cache entry", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`body-${calls}`, { status: 200, statusText: "OK" });
  };

  const url = "https://example.test/keyed-cache";
  const first = await fetchWithTimeout(url, { cacheTtlMs: 1000, headers: { "x-api-key": "key-one" } });
  const second = await fetchWithTimeout(url, { cacheTtlMs: 1000, headers: { "x-api-key": "key-two" } });
  const third = await fetchWithTimeout(url, { cacheTtlMs: 1000, headers: { "x-api-key": "key-one" } });

  assert.equal(await first.text(), "body-1");
  assert.equal(await second.text(), "body-2");
  assert.equal(await third.text(), "body-1");
  assert.equal(calls, 2);
});

test("the response cache evicts least-recently-used entries beyond capacity", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`body-${calls}`, { status: 200, statusText: "OK" });
  };

  const ttl = 60_000;
  // Fill the cache with 200 entries, then one more to push out the oldest.
  for (let index = 0; index < 201; index += 1) {
    await fetchWithTimeout(`https://example.test/lru-${index}`, { cacheTtlMs: ttl });
  }
  // The very first entry was evicted; fetching it again must hit the network.
  await fetchWithTimeout("https://example.test/lru-0", { cacheTtlMs: ttl });
  assert.equal(calls, 202);
  // Recent entries are still cached.
  await fetchWithTimeout("https://example.test/lru-200", { cacheTtlMs: ttl });
  assert.equal(calls, 202);
});
