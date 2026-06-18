import assert from "node:assert/strict";
import { test } from "node:test";
import { generateResearchIdeas, reviewResearchIdea } from "../src/researchIdeas.js";
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

const papers = [
  paper({ id: "a", title: "Graph neural networks for molecular property prediction", citationCount: 120 }),
  paper({ id: "b", title: "Benchmarking transformer models on tabular data", citationCount: 40 }),
];

test("generateResearchIdeas returns the requested count and bounded scores", () => {
  const ideas = generateResearchIdeas("molecular property prediction", papers, 3);
  assert.equal(ideas.length, 3);
  for (const idea of ideas) {
    assert.ok(idea.score >= 0 && idea.score <= 100, `score in range: ${idea.score}`);
    assert.ok(idea.title.length > 0);
  }
});

test("scores are ordered descending", () => {
  const ideas = generateResearchIdeas("graph neural networks", papers, 5);
  for (let i = 1; i < ideas.length; i++) {
    assert.ok(ideas[i - 1].score >= ideas[i].score);
  }
});

test("candidateMethods override is honored", () => {
  const ideas = generateResearchIdeas("tabular learning", papers, 2, {
    candidateMethods: ["transformer"],
  });
  assert.ok(ideas.some((idea) => idea.hypothesis.includes("transformer")));
});

test("reviewResearchIdea returns bounded sub-scores and a verdict", () => {
  const review = reviewResearchIdea(
    "molecular property prediction",
    "Use graph neural networks to benchmark molecular property prediction under distribution shift.",
    papers,
  );
  for (const value of [review.score, review.novelty, review.feasibility, review.evidenceFit]) {
    assert.ok(value >= 0 && value <= 100);
  }
  assert.ok(["strong", "promising", "weak"].includes(review.verdict));
});
