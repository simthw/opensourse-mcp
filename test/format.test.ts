import assert from "node:assert/strict";
import { test } from "node:test";
import { formatScreenedResult, truncateWords } from "../src/format.js";
import type { Paper, ScreenedResult } from "../src/types.js";

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

function result(papers: Paper[], extra: Partial<ScreenedResult> = {}): ScreenedResult {
  return {
    topic: "topic",
    criteria: {},
    totalRawResults: papers.length,
    totalDedupedCandidates: papers.length,
    returned: papers.length,
    results: papers,
    warnings: [],
    ...extra,
  };
}

test("truncateWords leaves short text untouched", () => {
  assert.equal(truncateWords("one two three", 150), "one two three");
});

test("truncateWords cuts at the word limit and marks the cut", () => {
  const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  const out = truncateWords(text, 150);
  assert.ok(out.endsWith("…"));
  assert.equal(out.slice(0, -1).split(" ").length, 150);
  assert.ok(!out.includes("w150"));
});

test("the formatter emits abstracts so the caller can judge relevance", () => {
  const out = formatScreenedResult(
    result([
      paper({
        title: "A thermodynamics paper",
        abstract: "We study nonequilibrium thermodynamics in microbial communities.",
      }),
    ]),
  );
  assert.match(out, /Abstract: We study nonequilibrium thermodynamics/);
});

test("the formatter truncates long abstracts to 150 words", () => {
  const long = Array.from({ length: 400 }, (_, i) => `token${i}`).join(" ");
  const out = formatScreenedResult(result([paper({ title: "Long", abstract: long })]));
  const abstractLine = out.split("\n").find((line) => line.startsWith("Abstract: "))!;
  const wordCount = abstractLine.replace("Abstract: ", "").replace(/…$/, "").split(" ").length;
  assert.equal(wordCount, 150);
});

test("the formatter omits the Abstract line when a paper has none", () => {
  const out = formatScreenedResult(result([paper({ title: "No abstract here" })]));
  assert.ok(!out.includes("Abstract:"));
});
