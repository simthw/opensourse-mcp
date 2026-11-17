import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverAndScreen, expandRelated } from "../src/workflow.js";

const originalFetch = globalThis.fetch;

function withMockFetch(t: { after: (cb: () => void) => void }, impl: (url: URL) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return impl(url);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function openAlexPage(results: unknown[], count: number, nextCursor?: string): Response {
  return new Response(JSON.stringify({ meta: { count, next_cursor: nextCursor }, results }), { status: 200 });
}

test("discover backfills by paging when screening falls short of the limit", async (t) => {
  withMockFetch(t, (url) => {
    assert.equal(url.hostname, "api.openalex.org");
    const cursor = url.searchParams.get("cursor");
    if (cursor === "*" || cursor === null) {
      return openAlexPage(
        [{ id: "W1", display_name: "alpha study one", publication_year: 2024, cited_by_count: 5 }],
        5,
        "c2",
      );
    }
    assert.equal(cursor, "c2");
    return openAlexPage(
      [{ id: "W2", display_name: "alpha study two", publication_year: 2024, cited_by_count: 3 }],
      5,
    );
  });

  const result = await discoverAndScreen({
    topic: "alpha study",
    sources: ["openalex"],
    limit: 2,
    perSourceLimit: 1,
  });

  assert.equal(result.returned, 2);
  assert.deepEqual(
    result.results.map((paper) => paper.title),
    ["alpha study one", "alpha study two"],
  );
  const report = result.sourceReports?.[0];
  assert.equal(report?.pages, 2);
  assert.equal(report?.retrieved, 2);
  assert.equal(report?.available, 5);
});

test("discover rejects a topic with no searchable content words before querying providers", async () => {
  let fetched = false;
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => discoverAndScreen({ topic: "the of and", sources: ["openalex"] }), /no searchable content words/);
    assert.equal(fetched, false, "no provider should be queried for a meaningless topic");
  } finally {
    globalThis.fetch = previous;
  }
});

const variantPaper = {
  id: "W9",
  display_name: "Available energy flux drives microbial communities",
  publication_year: 2019,
  cited_by_count: 168,
};

test("a paper matching only a query variant's vocabulary is kept when variants are supplied", async (t) => {
  withMockFetch(t, () => openAlexPage([variantPaper], 1));

  const withoutVariants = await discoverAndScreen({
    topic: "entropy production ecosystems",
    sources: ["openalex"],
    limit: 5,
  });
  assert.equal(withoutVariants.returned, 0, "single-query AND vocabulary cannot reach the paper");
  assert.equal(withoutVariants.rejectedBy["below-relevance"], 1);

  const withVariants = await discoverAndScreen({
    topic: "entropy production ecosystems",
    queries: ["energy flux microbial communities"],
    sources: ["openalex"],
    limit: 5,
  });
  assert.equal(withVariants.returned, 1, "the variant's terms keep the paper");
  assert.deepEqual(withVariants.retrieval?.queries, [
    "entropy production ecosystems",
    "energy flux microbial communities",
  ]);
  assert.ok(withVariants.retrieval?.terms.includes("communities"));
});

test("a single-query search that retrieves little warns about narrow vocabulary", async (t) => {
  withMockFetch(t, () => openAlexPage([variantPaper], 1));

  const result = await discoverAndScreen({
    topic: "available energy flux microbial communities",
    sources: ["openalex"],
    limit: 10,
  });

  assert.ok(
    result.warnings.some((warning) => /Narrow retrieval/.test(warning)),
    JSON.stringify(result.warnings),
  );
});

test("expandRelated falls back to OpenAlex related works when S2 fails", async (t) => {
  withMockFetch(t, (url) => {
    const href = url.href;
    if (href.includes("recommendations/v1/papers/forpaper")) {
      // S2 recommendations are unavailable (rate-limited).
      return new Response("too many requests", { status: 429 });
    }
    if (href.includes("/graph/v1/paper/")) {
      return new Response(JSON.stringify({ externalIds: { DOI: "10.1038/z" }, title: "Seed paper" }), {
        status: 200,
      });
    }
    if (url.pathname.startsWith("/works/doi:")) {
      // related_works must be requested explicitly via select, otherwise the
      // fallback silently finds nothing.
      assert.ok(
        url.searchParams.get("select")?.includes("related_works"),
        "the seed lookup must request related_works in select",
      );
      return new Response(
        JSON.stringify({
          id: "https://openalex.org/W1",
          display_name: "Seed paper",
          related_works: ["https://openalex.org/W2", "https://openalex.org/W3"],
        }),
        { status: 200 },
      );
    }
    if (url.searchParams.get("filter")?.startsWith("openalex_id:")) {
      return openAlexPage(
        [
          { id: "https://openalex.org/W2", display_name: "alpha related one", publication_year: 2023 },
          { id: "https://openalex.org/W3", display_name: "alpha related two", publication_year: 2022 },
        ],
        2,
      );
    }
    return new Response("unexpected", { status: 404 });
  });

  const result = await expandRelated({ semanticScholarPaperId: "DOI:10.1038/z", limit: 10 });

  assert.equal(result.returned, 2);
  assert.deepEqual(
    result.results.map((paper) => paper.title),
    ["alpha related one", "alpha related two"],
  );
  assert.ok(result.warnings.some((warning) => warning.includes("semantic_scholar:")));
  assert.ok(!result.warnings.some((warning) => warning.includes("openalex fallback:")));
});
