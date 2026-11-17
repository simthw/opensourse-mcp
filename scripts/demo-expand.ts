import { expandRelated } from "../src/workflow.js";

// Seed: Marsland et al. 2019, "Available energy fluxes drive a transition..."
// S2 paper id resolved from the DOI via the S2 graph API.
const SEED_DOI = "10.1371/journal.pcbi.1006793";

const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
let seedId = `DOI:${SEED_DOI}`;

const t = Date.now();
const result = await expandRelated({
  semanticScholarPaperId: seedId,
  topic: "thermodynamics microbial community ecology",
  limit: 10,
  screeningCriteria: { requireTopicMatch: false },
});

console.log(`=== 耗时: ${((Date.now() - t) / 1000).toFixed(1)}s ===`);
console.log(`=== 返回 ${result.returned} 条 (raw ${result.totalRawResults}, deduped ${result.totalDedupedCandidates}) ===`);
if (result.warnings.length > 0) console.log("warnings:", result.warnings);
console.log("rejectedBy:", result.rejectedBy);
console.log("");

result.results.forEach((p, i) => {
  console.log(`--- ${i + 1}. ${p.title}`);
  console.log(`    ${p.authors.slice(0, 3).join(", ")} | ${p.year ?? "?"} | ${p.venue ?? "?"} | ${p.citationCount ?? "?"} cites | [${p.sources.join("+")}]`);
  console.log(`    ABSTRACT: ${(p.abstract ?? "(none)").slice(0, 900)}`);
  console.log(`    DOI: ${p.doi ?? "-"}`);
  console.log("");
});
