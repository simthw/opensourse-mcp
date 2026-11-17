import assert from "node:assert/strict";
import { test } from "node:test";
import { screenAndRank, screenAndRankDetailed } from "../src/screening.js";
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

test("a default exclusion is suppressed when the topic uses the word itself", () => {
  // "correction" is a default publication-type exclusion, but it is also the
  // subject of this topic. Applying it would reject every on-topic paper.
  const papers = [
    paper({
      id: "on-topic",
      title: "Surface codes for quantum error correction",
      abstract: "We study quantum error correction with surface codes.",
    }),
  ];
  const out = screenAndRank("quantum error correction surface codes", papers, {}, 10);
  assert.deepEqual(out.map((p) => p.id), ["on-topic"]);

  // Elsewhere the same default still drops an actual correction notice.
  const notice = screenAndRank(
    "quantum computing hardware",
    [paper({ id: "notice", title: "quantum computing hardware", abstract: "Correction to the above article" })],
    {},
    10,
  );
  assert.equal(notice.length, 0, "a correction notice is still filtered");
});

test("a caller-supplied exclusion always applies, even when the topic contains it", () => {
  const papers = [
    paper({ id: "a", title: "quantum error correction", abstract: "quantum error correction survey" }),
  ];
  const out = screenAndRank("quantum error correction", papers, { exclude: ["correction"] }, 10);
  assert.equal(out.length, 0, "an explicit exclusion is an instruction, not a heuristic");
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

test("cross-source confirmation still raises the reported score", () => {
  const papers = [
    paper({ id: "solo", title: "deep learning topic", sources: ["openalex"] }),
    paper({ id: "multi", title: "deep learning topic", sources: ["openalex", "semantic_scholar"] }),
  ];
  const out = screenAndRank("deep learning topic", papers, {}, 10);
  const solo = out.find((p) => p.id === "solo")!;
  const multi = out.find((p) => p.id === "multi")!;
  // Ordering is neutral (see compareCandidates) but the score still reflects
  // cross-source confirmation, which callers may use for their own ranking.
  assert.ok(multi.score! > solo.score!, "multi-source record scores higher");
  assert.ok(multi.reasons!.some((r) => r.includes("confirmed by")));
});

test("respects the limit", () => {
  const papers = Array.from({ length: 5 }, (_, i) => paper({ id: String(i), title: "topic here" }));
  const out = screenAndRank("topic here", papers, {}, 2);
  assert.equal(out.length, 2);
});

// ---- token-boundary term matching (8 verified cases) ----------------------

test("token boundary matching rejects substring false hits", () => {
  const cases: Array<{ term: string; text: string; expected: boolean }> = [
    // 1. "omics" must NOT match inside "economics"
    { term: "omics", text: "the economics of healthcare", expected: false },
    // 2. "omics" matches standalone "multi-omics" (hyphen is a separator)
    { term: "omics", text: "multi-omics data analysis", expected: true },
    // 3. "graph" must NOT match inside "paragraph"
    { term: "graph", text: "rewrite every paragraph", expected: false },
    // 4. "graph" matches "graph neural networks"
    { term: "graph", text: "graph neural networks", expected: true },
    // 5. hyphens are token separators: "single-cell" matches hyphenated text
    { term: "single cell", text: "single-cell multi-omics integration", expected: true },
    // 6. case-insensitive: "rna sequencing" matches "RNA-Seq pipeline"
    { term: "rna sequencing", text: "an RNA-Seq pipeline", expected: true },
    // 7. adjacent multi-word terms match
    { term: "topic model", text: "a topic model paper", expected: true },
    // 8. "cell" must NOT match "cellular"
    { term: "cell", text: "cellular processes", expected: false },
  ];
  for (const { term, text, expected } of cases) {
    const out = screenAndRank(term, [paper({ id: "p", title: text })], {}, 10);
    assert.equal(
      out.length > 0 ? "kept" : "rejected",
      expected ? "kept" : "rejected",
      `term "${term}" vs "${text}"`,
    );
  }
});

// ---- minimum relevance floor ----------------------------------------------

test("papers without topic-term hits fall below the relevance floor", () => {
  const papers = [
    paper({ id: "relevant", title: "graph neural networks survey" }),
    paper({ id: "unrelated", title: "cooking recipes for winter" }),
  ];
  const outcome = screenAndRankDetailed("graph neural networks", papers, {}, 10);
  assert.deepEqual(outcome.selected.map((p) => p.id), ["relevant"]);
  assert.equal(outcome.rejectedBy["below-relevance"], 1);
  assert.ok(outcome.warnings.some((warning) => warning.includes("rejected candidates")));
});

test("the relevance floor is skipped when the topic has no usable terms", () => {
  const papers = [paper({ id: "a", title: "anything goes" })];
  const outcome = screenAndRankDetailed("a of the", papers, {}, 10);
  assert.equal(outcome.selected.length, 1);
});


// ---- ordered exclusion codes -----------------------------------------------

test("rejected records carry the first matching exclusion code", () => {
  const papers = [
    paper({ id: "old", title: "graph models", year: 1990 }),
    paper({ id: "obscure", title: "graph models", citationCount: 1 }),
    paper({ id: "editorial", title: "graph models", abstract: "this editorial summarizes" }),
    paper({ id: "missing-must", title: "graph models" }),
    paper({
      id: "preprint",
      title: "graph models",
      abstract: "uses a transformer architecture",
      sources: ["arxiv"],
      arxivId: "2401.01234",
    }),
  ];
  const outcome = screenAndRankDetailed("graph models", papers, {
    minCitations: 10,
    yearFrom: 2000,
    mustInclude: ["transformer"],
    includePreprints: false,
  });

  const codes = new Map(outcome.rejected.map((record) => [record.paper.id, record.code]));
  assert.equal(codes.get("old"), "year");
  assert.equal(codes.get("obscure"), "min-citations");
  assert.equal(codes.get("editorial"), "excluded-term");
  assert.equal(codes.get("missing-must"), "missing-must");
  assert.equal(codes.get("preprint"), "preprint");
  assert.equal(outcome.rejectedBy.year, 1);
  assert.equal(outcome.rejectedBy["missing-must"], 1);
});

// ---- unknown citation counts pass minCitations (A2) ------------------------

test("unknown citation counts are not silently rejected by minCitations", () => {
  const papers = [paper({ id: "arxiv-only", title: "graph neural networks", citationCount: undefined })];
  const outcome = screenAndRankDetailed("graph neural networks", papers, { minCitations: 1 }, 10);
  assert.equal(outcome.selected.length, 1);
  assert.ok(outcome.selected[0].reasons?.some((reason) => reason.includes("citation count unknown")));
});

// ---- neutral, explainable ordering ----------------------------------------

test("candidates are ordered by abstract topic coverage before year", () => {
  const papers = [
    paper({
      id: "title-only-hit",
      title: "Thermodynamics of communities",
      abstract: "We study energetic constraints.",
      year: 2025,
    }),
    paper({
      id: "abstract-rich",
      title: "An energetic view",
      abstract: "We connect thermodynamics with community ecology models.",
      year: 2010,
    }),
  ];
  const out = screenAndRank("thermodynamics community ecology", papers, {}, 10);
  assert.equal(out[0].id, "abstract-rich", "more topic terms in the abstract ranks first");
});

test("a newer paper is not buried under an older highly cited one", () => {
  const papers = [
    paper({
      id: "old-classic",
      title: "Community ecology review",
      abstract: "A survey of community ecology.",
      year: 2004,
      citationCount: 5000,
    }),
    paper({
      id: "new-paper",
      title: "Community ecology revisited",
      abstract: "A fresh look at community ecology.",
      year: 2025,
      citationCount: 3,
    }),
  ];
  const out = screenAndRank("community ecology", papers, {}, 10);
  assert.equal(out[0].id, "new-paper", "recency outranks raw citation counts");
});

test("citation count breaks ties within the same year", () => {
  const papers = [
    paper({
      id: "few-cites",
      title: "Community ecology alpha",
      abstract: "About community ecology.",
      year: 2020,
      citationCount: 5,
    }),
    paper({
      id: "many-cites",
      title: "Community ecology beta",
      abstract: "About community ecology.",
      year: 2020,
      citationCount: 500,
    }),
  ];
  const out = screenAndRank("community ecology", papers, {}, 10);
  assert.equal(out[0].id, "many-cites");
});

test("ordering is deterministic for fully tied candidates", () => {
  const papers = [
    paper({ id: "b", title: "Beta paper", abstract: "community ecology", year: 2020, citationCount: 1 }),
    paper({ id: "a", title: "Alpha paper", abstract: "community ecology", year: 2020, citationCount: 1 }),
  ];
  const first = screenAndRank("community ecology", papers, {}, 10).map((p) => p.id);
  const second = screenAndRank("community ecology", [...papers].reverse(), {}, 10).map((p) => p.id);
  assert.deepEqual(first, ["a", "b"]);
  assert.deepEqual(first, second, "input order must not change the result");
});