import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalArxivId, canonicalDoi, matchSeedPaper, mergePapers, sanitizeTopic, titleKey } from "../src/utils.js";
import type { Paper } from "../src/types.js";

function paper(overrides: Partial<Paper>): Paper {
  return {
    id: "x",
    title: "Untitled",
    authors: [],
    sources: ["openalex"],
    sourceIds: {},
    ...overrides,
  };
}

test("canonicalDoi strips prefixes and lowercases", () => {
  assert.equal(canonicalDoi("https://doi.org/10.1/AbC"), "10.1/abc");
  assert.equal(canonicalDoi("doi:10.2/x"), "10.2/x");
  assert.equal(canonicalDoi("https://dx.doi.org/10.3/Y"), "10.3/y");
  assert.equal(canonicalDoi(undefined), undefined);
});

test("canonicalArxivId normalizes urls, prefixes, and versions", () => {
  assert.equal(canonicalArxivId("https://arxiv.org/abs/2401.01234v2"), "2401.01234");
  assert.equal(canonicalArxivId("arXiv:2401.01234"), "2401.01234");
  assert.equal(canonicalArxivId("https://arxiv.org/pdf/cs/0112017.pdf"), "cs/0112017");
});

test("titleKey drops leading articles and punctuation", () => {
  assert.equal(titleKey("The   A,  Study!"), titleKey("a study"));
});

test("mergePapers drops provider nulls so structured output stays schema-clean", () => {
  // OpenAlex returns oa_url: null, and S2 can return abstract/citationCount
  // null. Those used to leak into structuredContent and made a strict input
  // schema reject the paper when a caller passed results back.
  const merged = mergePapers([
    {
      ...paper({ title: "Null-bearing record" }),
      year: null,
      venue: null,
      oaUrl: null,
      abstract: null,
      citationCount: null,
      authors: null,
      sourceIds: null,
    } as unknown as Paper,
  ]);
  const record = merged[0] as Record<string, unknown>;
  assert.equal(merged.length, 1);
  for (const key of ["year", "venue", "oaUrl", "abstract", "citationCount"]) {
    assert.ok(!(key in record) || record[key] !== null, `${key} must not be null`);
  }
  assert.deepEqual(merged[0].authors, []);
  assert.deepEqual(merged[0].sourceIds, {});
  assert.ok(!JSON.stringify(merged).includes(":null"));
});

test("mergePapers dedupes by DOI and unions sources", () => {
  const merged = mergePapers([
    paper({ doi: "10.1/x", sources: ["openalex"], sourceIds: { openalex: "W1" } }),
    paper({ doi: "https://doi.org/10.1/X", sources: ["semantic_scholar"], sourceIds: { semantic_scholar: "S1" } }),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual([...merged[0].sources].sort(), ["openalex", "semantic_scholar"]);
});

test("mergePapers preserves a real 0 citation count instead of dropping it", () => {
  const merged = mergePapers([
    paper({ arxivId: "2401.01234", citationCount: 0 }),
    paper({ arxivId: "2401.01234", citationCount: 0 }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].citationCount, 0);
});

test("mergePapers keeps the larger citation count", () => {
  const merged = mergePapers([
    paper({ doi: "10.9/z", citationCount: 3 }),
    paper({ doi: "10.9/z", citationCount: 11 }),
  ]);
  assert.equal(merged[0].citationCount, 11);
});

test("mergePapers without identifiers falls back to title key", () => {
  const merged = mergePapers([paper({ title: "The Deep Net" }), paper({ title: "Deep Net" })]);
  assert.equal(merged.length, 1);
});

test("sanitizeTopic strips quotes, colons, brackets, and backslashes", () => {
  assert.equal(sanitizeTopic('graph "neural": [networks] \\ survey'), "graph neural networks survey");
  assert.equal(sanitizeTopic("  multiple   spaces\tand\nnewlines  "), "multiple spaces and newlines");
  assert.equal(sanitizeTopic("unpaired ( paren"), "unpaired paren");
});

test("mergePapers merges same-title records without a shared identifier", () => {
  const merged = mergePapers([
    paper({
      id: "W1",
      title: "Breast cancer atlas",
      doi: "10.1038/s41588-021-00911-1",
      venue: "Nature Genetics",
      year: 2021,
      sources: ["openalex"],
      sourceIds: { openalex: "W1" },
    }),
    paper({
      id: "arxiv-1",
      title: "breast cancer  atlas",
      arxivId: "2101.01234",
      sources: ["arxiv"],
      sourceIds: { arxiv: "2101.01234" },
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual([...merged[0].sources].sort(), ["arxiv", "openalex"]);
  assert.equal(merged[0].doi, "10.1038/s41588-021-00911-1");
  assert.equal(merged[0].arxivId, "2101.01234");
  assert.equal(merged[0].venue, "Nature Genetics");
});

test("mergePapers prefers the formally published record for venue and url", () => {
  const merged = mergePapers([
    paper({ id: "a", title: "same title", venue: "arXiv", url: "https://arxiv.org/abs/1", year: 2023 }),
    paper({ id: "b", title: "same title", venue: "Nature Genetics", url: "https://doi.org/10.1/x", year: 2022 }),
  ]);
  assert.equal(merged[0].venue, "Nature Genetics");
  assert.equal(merged[0].url, "https://doi.org/10.1/x");
});

test("matchSeedPaper resolves DOI, arXiv ID, and title seeds", () => {
  const pool = [
    paper({
      id: "W1",
      title: "Breast cancer atlas",
      doi: "10.1038/s41588-021-00911-1",
      arxivId: undefined,
      sources: ["openalex"],
      sourceIds: { openalex: "W1" },
    }),
    paper({ id: "A1", title: "A preprint", arxivId: "2401.01234" }),
    paper({
      id: "W2",
      title: "Deep unsupervised learning",
      doi: "10.48550/arxiv.1503.03585",
      sources: ["openalex"],
      sourceIds: { openalex: "W2" },
    }),
  ];
  assert.equal(matchSeedPaper(pool, "10.1038/s41588-021-00911-1")?.id, "W1");
  assert.equal(matchSeedPaper(pool, "arXiv:2401.01234")?.id, "A1");
  assert.equal(matchSeedPaper(pool, "the Breast Cancer Atlas")?.id, "W1");
  assert.equal(matchSeedPaper(pool, "unknown seed"), undefined);
});

test("matchSeedPaper resolves an arXiv-ID seed to its OpenAlex arXiv-DOI record", () => {
  const pool = [
    paper({
      id: "W2",
      title: "Deep unsupervised learning",
      doi: "10.48550/arxiv.1503.03585",
      sources: ["openalex"],
      sourceIds: { openalex: "W2" },
    }),
  ];
  assert.equal(matchSeedPaper(pool, "arXiv:1503.03585")?.id, "W2");
});

test("canonicalDoi treats arXiv identifiers as absent, not as DOIs", () => {
  assert.equal(canonicalDoi("arXiv:1503.03585"), undefined);
});
