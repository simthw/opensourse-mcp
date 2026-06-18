import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalArxivId, canonicalDoi, mergePapers, titleKey } from "../src/utils.js";
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
