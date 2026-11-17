import { discoverAndScreen } from "../src/workflow.js";

const topic = process.argv[2] ?? "thermodynamics community ecology";

const t = Date.now();
const result = await discoverAndScreen({ topic, limit: 12 });
const elapsed = Date.now() - t;

console.log(`TOPIC: ${topic}`);
console.log(`ELAPSED: ${(elapsed / 1000).toFixed(1)}s`);
console.log(`returned: ${result.returned} / raw ${result.totalRawResults} / deduped ${result.totalDedupedCandidates}`);
console.log(`cross-source in top-12: ${result.results.filter((p) => p.sources.length > 1).length}`);
for (const r of result.sourceReports ?? []) {
  console.log(`  ${r.source}: retrieved=${r.retrieved} available=${r.available ?? "?"} pages=${r.pages} ${r.note ? `(${r.note})` : ""}`);
}
if (result.warnings.length > 0) console.log("warnings:", result.warnings);
