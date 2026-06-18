import assert from "node:assert/strict";
import { test } from "node:test";
import { screenAndRank } from "../src/screening.js";
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

test("mustInclude rejects papers missing the required phrase", () => {
  const papers = [
    paper({ id: "a", title: "single-cell multi-omics integration" }),
    paper({ id: "b", title: "bulk rna sequencing pipeline" }),
  ];
  const out = screenAndRank("omics integration", papers, { mustInclude: ["single-cell"] }, 10);
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("exclude and default exclude terms drop matching papers", () => {
  const papers = [
    paper({ id: "a", title: "a survey", abstract: "this editorial discusses trends" }),
    paper({ id: "b", title: "a method", abstract: "we propose a model" }),
  ];
  const out = screenAndRank("method", papers, {}, 10);
  assert.deepEqual(out.map((p) => p.id), ["b"]);
});

test("minCitations filters low-citation papers", () => {
  const papers = [
    paper({ id: "a", title: "topic model", citationCount: 1 }),
    paper({ id: "b", title: "topic model", citationCount: 50 }),
  ];
  const out = screenAndRank("topic model", papers, { minCitations: 10 }, 10);
  assert.deepEqual(out.map((p) => p.id), ["b"]);
});

test("includePreprints=false drops arxiv-only papers", () => {
  const papers = [
    paper({ id: "a", title: "topic", sources: ["arxiv"], arxivId: "2401.01234" }),
    paper({ id: "b", title: "topic", sources: ["openalex"] }),
  ];
  const out = screenAndRank("topic", papers, { includePreprints: false }, 10);
  assert.deepEqual(out.map((p) => p.id), ["b"]);
});

test("cross-source confirmation ranks higher", () => {
  const papers = [
    paper({ id: "solo", title: "deep learning topic", sources: ["openalex"] }),
    paper({ id: "multi", title: "deep learning topic", sources: ["openalex", "semantic_scholar"] }),
  ];
  const out = screenAndRank("deep learning topic", papers, {}, 10);
  assert.equal(out[0].id, "multi");
});

test("respects the limit", () => {
  const papers = Array.from({ length: 5 }, (_, i) => paper({ id: String(i), title: "topic here" }));
  const out = screenAndRank("topic here", papers, {}, 2);
  assert.equal(out.length, 2);
});
