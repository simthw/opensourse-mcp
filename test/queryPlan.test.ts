import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueryPlan, variantGroups } from "../src/queryPlan.js";

test("the primary topic is always the first variant and duplicates collapse", () => {
  const plan = buildQueryPlan("entropy production ecosystems", [
    "energy flux microbial communities",
    "Entropy Production Ecosystems",
    "  energy   flux microbial communities  ",
  ]);
  assert.equal(plan.variants[0], "entropy production ecosystems");
  assert.deepEqual(plan.variants, [
    "entropy production ecosystems",
    "energy flux microbial communities",
  ]);
});

test("screening terms are the union over variants, first occurrence wins", () => {
  const plan = buildQueryPlan("entropy production ecosystems", ["energy flux microbial communities"]);
  assert.deepEqual(plan.terms, [
    "entropy",
    "production",
    "ecosystems",
    "energy",
    "flux",
    "microbial",
    "communities",
  ]);
});

test("variants with no content words are dropped instead of producing empty queries", () => {
  const plan = buildQueryPlan("entropy production ecosystems", ["the of and", "a an the", ""]);
  assert.deepEqual(plan.variants, ["entropy production ecosystems"]);
});

test("variant count is capped", () => {
  const plan = buildQueryPlan("topic zero", Array.from({ length: 10 }, (_, i) => `variant number ${i}`));
  assert.equal(plan.variants.length, 6);
});

test("variantGroups returns one token group per distinct variant", () => {
  const groups = variantGroups("entropy production ecosystems", [
    "entropy production ecosystems",
    "energy flux microbial communities",
    "energy flux microbial communities",
  ]);
  assert.deepEqual(groups, [
    ["entropy", "production", "ecosystems"],
    ["energy", "flux", "microbial", "communities"],
  ]);
});
