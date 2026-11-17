import { discoverAndScreen } from "../src/workflow.js";

function line(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

// A1 + A2: arXiv-only "graph neural networks"
const a1 = await discoverAndScreen({ topic: "graph neural networks", sources: ["arxiv"], limit: 10 });
line("A1 returned", a1.results.length);
line("A1 titles containing graph", `${a1.results.filter((p) => /graph/i.test(p.title)).length}/10`);

const a2 = await discoverAndScreen({
  topic: "graph neural networks",
  sources: ["arxiv"],
  limit: 10,
  screeningCriteria: { minCitations: 1 },
});
line(
  "A2 returned with minCitations=1 (all annotated unknown-citations)",
  a2.results.filter((p) => p.reasons?.some((r) => r.includes("citation count unknown"))).length,
);

// A3: 4-source biomedical run (S2 rate-limits without an API key; retry
// after a cooldown — its anonymous quota recovers over time).
let a3: Awaited<ReturnType<typeof discoverAndScreen>> | undefined;
for (let attempt = 1; attempt <= 4; attempt += 1) {
  const run = await discoverAndScreen({ topic: "single-cell transcriptomics", limit: 10 });
  const cross = run.results.filter((p) => p.sources.length > 1).length;
  console.log(`A3 attempt ${attempt}: returned=${run.results.length}, cross-source=${cross}`);
  line(`A3 source reports (attempt ${attempt})`, run.sourceReports?.map((r) => `${r.source}: retrieved ${r.retrieved}, available ${r.available ?? "?"}, pages ${r.pages}`));
  if (cross > 0) {
    a3 = run;
    break;
  }
  console.log(`A3 attempt ${attempt} warnings:`, run.warnings);
  if (attempt < 4) {
    console.log(`A3 waiting 45s for S2 rate limit to cool down...`);
    await new Promise((resolve) => setTimeout(resolve, 45_000));
  }
}
line("A3 cross-source confirmed in top-10", a3?.results.filter((p) => p.sources.length > 1).length);

// A4: seed calibration on its own topical run
const seed = "10.1038/s41588-021-00911-1";
const a4 = await discoverAndScreen({ topic: "breast cancer atlas", limit: 10, seedPapers: [seed] });
line("A4 seed report (breast-cancer-atlas DOI)", a4.seedReports);

// A5: OpenAlex meta.count reported after server-side filtering
const a5 = await discoverAndScreen({ topic: "omics integration", sources: ["openalex"], limit: 5 });
line("A5 OpenAlex available (default incl. is_retracted:false)", a5.sourceReports?.[0]?.available);
const a5b = await discoverAndScreen({
  topic: "omics integration",
  sources: ["openalex"],
  limit: 5,
  includePreprints: false,
  screeningCriteria: { minCitations: 1 },
});
line("A5 OpenAlex available (with type:article + cited_by_count:>1)", a5b.sourceReports?.[0]?.available);

// A6: retracted paper excluded by default, retrievable with includeRetracted
const retractedSeed = "10.1016/j.ijantimicag.2020.105949"; // 5650-citation retracted HCQ trial
const retractedTopic = "hydroxychloroquine azithromycin covid 19 treatment";
const a6a = await discoverAndScreen({
  topic: retractedTopic,
  sources: ["openalex"],
  limit: 10,
  perSourceLimit: 100,
  seedPapers: [retractedSeed],
});
line("A6 default run (seed must be absent)", a6a.seedReports);
const a6b = await discoverAndScreen({
  topic: retractedTopic,
  sources: ["openalex"],
  limit: 10,
  perSourceLimit: 100,
  includeRetracted: true,
  seedPapers: [retractedSeed],
});
line("A6 includeRetracted run (seed retrievable)", a6b.seedReports);
line("A6 available default vs open", [a6a.sourceReports?.[0]?.available, a6b.sourceReports?.[0]?.available]);
console.log("DONE");
