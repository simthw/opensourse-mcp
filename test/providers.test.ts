import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery, searchArxivPage } from "../src/providers/arxiv.js";
import { searchEuropePmcPage } from "../src/providers/europepmc.js";
import { searchOpenAlexPage } from "../src/providers/openalex.js";
import { exportToZotero } from "../src/providers/zotero.js";
import type { Paper, SearchOptions } from "../src/types.js";

const originalFetch = globalThis.fetch;

function options(overrides: Partial<SearchOptions>): SearchOptions {
  return {
    topic: "graph neural networks",
    limit: 20,
    sources: ["arxiv"],
    includePreprints: true,
    ...overrides,
  };
}

function withMockFetch(t: { after: (cb: () => void) => void }, impl: typeof fetch): void {
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("buildQuery returns a plain query when no year range is set", () => {
  assert.equal(buildQuery(options({})), "all:graph AND all:neural AND all:networks");
});

test("buildQuery pushes the year range into submittedDate", () => {
  const q = buildQuery(options({ yearFrom: 2020, yearTo: 2022 }));
  assert.match(q, /submittedDate:\[20200101000000 TO 20221231235959\]/);
  assert.match(q, /all:graph AND all:neural AND all:networks/);
});

test("buildQuery handles an open-ended lower bound", () => {
  const q = buildQuery(options({ yearFrom: 2021 }));
  assert.match(q, /\[20210101000000 TO \d{4}1231235959\]/);
});

test("buildQuery sanitizes dangerous punctuation and keeps at most 8 tokens", () => {
  const q = buildQuery(
    options({ topic: 'graph "neural": [networks] survey \\ review of deep models today really' }),
  );
  assert.ok(!q.includes('"'));
  assert.ok(!q.includes(":networks") || !q.includes("["));
  assert.equal(q.split(" AND ").length, 8);
});

test("buildQuery rejects topics with no searchable tokens", () => {
  assert.throws(() => buildQuery(options({ topic: "\\ \" : [" })));
});

test("buildQuery ORs query variants while ANDing the words inside each", () => {
  const q = buildQuery(
    options({
      topic: "entropy production ecosystems",
      variants: ["entropy production ecosystems", "energy flux microbial communities"],
    }),
  );
  assert.equal(
    q,
    "(all:entropy AND all:production AND all:ecosystems) OR (all:energy AND all:flux AND all:microbial AND all:communities)",
  );
});

const arxivErrorFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/api/query</id>
    <title>Error</title>
    <summary>Incorrect search query</summary>
  </entry>
</feed>`;

const arxivOkFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>ArXiv Query</title>
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <title>A graph paper</title>
    <published>2024-01-05T00:00:00Z</published>
    <author><name>A Author</name></author>
    <summary>We study graphs</summary>
  </entry>
</feed>`;

test("arXiv error entries surface as errors, never as papers", async (t) => {
  withMockFetch(t, async () => new Response(arxivErrorFeed, { status: 200 }));
  await assert.rejects(() => searchArxivPage(options({ topic: "bad [ query" })), /arXiv query error/);
});

test("arXiv parses opensearch:totalResults and leaves citationCount unknown", async (t) => {
  withMockFetch(t, async () => new Response(arxivOkFeed, { status: 200 }));
  const page = await searchArxivPage(options({ topic: "graph paper" }));
  assert.equal(page.available, 42);
  assert.equal(page.papers.length, 1);
  assert.equal(page.papers[0].citationCount, undefined);
  assert.equal(page.papers[0].arxivId, "2401.01234");
});

const openAlexFixture = {
  meta: { count: 105, next_cursor: "cursor-2" },
  results: [
    {
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1/X",
      display_name: "A study",
      publication_year: 2023,
      cited_by_count: 12,
      open_access: { is_oa: true, oa_url: "https://example.org/pdf" },
      primary_location: { source: { display_name: "Journal of Tests" }, landing_page_url: "https://example.org/1" },
      authorships: [{ author: { display_name: "A Author" } }],
    },
  ],
};

test("OpenAlex uses title_and_abstract.search, server-side filters, and reports meta.count", async (t) => {
  let requestedUrl = "";
  withMockFetch(t, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(openAlexFixture), { status: 200 });
  });

  const page = await searchOpenAlexPage(
    options({ topic: "omics integration", minCitations: 1, includePreprints: false }),
  );

  assert.equal(page.available, 105);
  assert.equal(page.nextCursor, "cursor-2");
  assert.ok(requestedUrl.includes("title_and_abstract.search%3A"));
  assert.ok(requestedUrl.includes("cited_by_count%3A%3E0"));
  assert.ok(requestedUrl.includes("is_retracted%3Afalse"));
  assert.ok(requestedUrl.includes("type%3Aarticle"));
  assert.ok(requestedUrl.includes("select="));
  assert.equal(page.papers[0].oaUrl, "https://example.org/pdf");
  assert.equal(page.papers[0].openAccess, true);
});

const europePmcFixture = {
  hitCount: 123,
  nextCursorMark: "epmc-cursor-2",
  resultList: {
    result: [
      {
        id: "36924946",
        pmid: "36924946",
        doi: "10.1038/s41588-023-01379-5",
        title: "Breast cancer atlas",
        authorString: "Smith A, Jones B",
        pubYear: "2023",
        firstPublicationDate: "2023-03-13",
        citedByCount: "150",
        journalInfo: { journal: { title: "Nature Genetics" } },
        isOpenAccess: "Y",
        abstractText: "We  profile  tumors",
        source: "MED",
      },
    ],
  },
};

test("OpenAlex ORs query variants while ANDing the words inside each", async (t) => {
  let requestedUrl = "";
  withMockFetch(t, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(openAlexFixture), { status: 200 });
  });

  await searchOpenAlexPage(
    options({
      topic: "entropy production ecosystems",
      variants: ["entropy production ecosystems", "energy flux microbial communities"],
    }),
  );

  const filter = new URL(requestedUrl).searchParams.get("filter") ?? "";
  const search = filter.split(",").find((part) => part.startsWith("title_and_abstract.search:")) ?? "";
  assert.equal(
    search,
    "title_and_abstract.search:(entropy production ecosystems) OR (energy flux microbial communities)",
  );
});

test("Europe PMC ORs query variants while ANDing the words inside each", async (t) => {
  let requestedUrl = "";
  withMockFetch(t, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(europePmcFixture), { status: 200 });
  });

  await searchEuropePmcPage(
    options({
      topic: "entropy production ecosystems",
      variants: ["entropy production ecosystems", "energy flux microbial communities"],
    }),
  );

  const query = new URL(requestedUrl).searchParams.get("query") ?? "";
  assert.ok(query.includes(" OR "), query);
  assert.ok(query.includes('TITLE:"energy"'), query);
  assert.ok(query.includes('TITLE:"entropy"'), query);
  assert.equal((query.match(/ OR /g) ?? []).length >= 1, true);
});

test("Europe PMC maps core fields and cursor pagination", async (t) => {
  let requestedUrl = "";
  withMockFetch(t, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(europePmcFixture), { status: 200 });
  });

  const page = await searchEuropePmcPage(options({ topic: "breast cancer atlas", limit: 20 }));

  assert.equal(page.available, 123);
  assert.equal(page.nextCursor, "epmc-cursor-2");
  assert.ok(requestedUrl.includes("resultType=core"));
  // Europe PMC pages with cursorMark; "cursor" is silently ignored and every
  // page would return page 1 again.
  assert.ok(requestedUrl.includes("cursorMark=*"));
  assert.ok(!requestedUrl.includes("cursor=*"));
  const paper = page.papers[0];
  assert.equal(paper.title, "Breast cancer atlas");
  assert.equal(paper.doi, "10.1038/s41588-023-01379-5");
  assert.equal(paper.year, 2023);
  assert.equal(paper.publishedDate, "2023-03-13");
  assert.equal(paper.citationCount, 150);
  assert.equal(paper.venue, "Nature Genetics");
  assert.equal(paper.pmid, "36924946");
  assert.deepEqual(paper.authors, ["Smith A", "Jones B"]);
  assert.equal(paper.openAccess, true);
});

function zoteroPaper(overrides: Partial<Paper>): Paper {
  return {
    id: "x",
    title: "Untitled",
    authors: ["A Author"],
    sources: ["openalex"],
    sourceIds: {},
    ...overrides,
  };
}

test("Zotero import counts real successes and surfaces failures", async (t) => {
  withMockFetch(t, async () =>
    new Response(
      JSON.stringify({
        success: { "0": "KEYAAA11", "1": "KEYBBB22" },
        failed: { "2": { code: 400, message: "Invalid item" } },
        last_version: 1234,
      }),
      { status: 200 },
    ),
  );

  const result = await exportToZotero({
    apiKey: "test-key",
    userId: "42",
    papers: [zoteroPaper({ id: "a", title: "Ok one" }), zoteroPaper({ id: "b", title: "Ok two" }), zoteroPaper({ id: "c", title: "Bad" })],
  });

  assert.equal(result.imported, 2);
  assert.equal(result.success, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].index, 2);
  assert.equal(result.failed[0].message, "Invalid item");
});
