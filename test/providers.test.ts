import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery } from "../src/providers/arxiv.js";
import type { SearchOptions } from "../src/types.js";

function options(overrides: Partial<SearchOptions>): SearchOptions {
  return {
    topic: "graph neural networks",
    limit: 20,
    sources: ["arxiv"],
    includePreprints: true,
    ...overrides,
  };
}

test("buildQuery returns a plain query when no year range is set", () => {
  assert.equal(buildQuery(options({})), "all:graph neural networks");
});

test("buildQuery pushes the year range into submittedDate", () => {
  const q = buildQuery(options({ yearFrom: 2020, yearTo: 2022 }));
  assert.match(q, /submittedDate:\[20200101000000 TO 20221231235959\]/);
  assert.match(q, /all:graph neural networks/);
});

test("buildQuery handles an open-ended lower bound", () => {
  const q = buildQuery(options({ yearFrom: 2021 }));
  assert.match(q, /\[20210101000000 TO \d{4}1231235959\]/);
});
