import { discoverAndScreen } from "../src/workflow.js";

const t = Date.now();
const result = await discoverAndScreen({
  topic: "thermodynamics community ecology",
  limit: 10,
  candidateLimit: 30,
});

console.log(`=== 耗时: ${((Date.now() - t) / 1000).toFixed(1)}s ===`);
console.log(`=== 返回 ${result.returned} 条候选（候选池上限 ${result.candidatesBeforeLimit}）===`);
for (const r of result.sourceReports ?? []) {
  console.log(`  ${r.source}: retrieved=${r.retrieved} available=${r.available ?? "?"} pages=${r.pages} ${r.note ? `(${r.note})` : ""}`);
}
if (result.warnings.length > 0) console.log("warnings:", result.warnings);
console.log("");

result.results.forEach((p, i) => {
  console.log(`--- ${i + 1}. ${p.title}`);
  console.log(`    ${p.authors.slice(0, 3).join(", ")} | ${p.year ?? "?"} | ${p.venue ?? "?"} | ${p.citationCount ?? "?"} cites | [${p.sources.join("+")}]`);
  console.log(`    ABSTRACT: ${p.abstract ?? "(none)"}`);
  console.log(`    DOI: ${p.doi ?? "-"}`);
  console.log("");
});

