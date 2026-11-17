import { discoverAndScreen } from "../src/workflow.js";

const result = await discoverAndScreen({
  topic: "nonequilibrium thermodynamics",
  limit: 10,
  perSourceLimit: 200,
  seedPapers: [
    "10.1063/1.2012462", // Bustamante et al., Physics Today 2005
    "arXiv:1503.03585", // Sohl-Dickstein et al. 2015 (diffusion models)
    "10.1088/0034-4885/75/12/126001", // Seifert, Rev. Mod. Phys. 2012 (stochastic thermodynamics)
  ],
});

for (const seed of result.seedReports ?? []) {
  console.log(
    `${seed.seed} -> ${seed.status}${seed.exclusionCode ? ` (excluded: ${seed.exclusionCode})` : ""}${seed.paperId ? ` [${seed.paperId}]` : ""}${seed.sources ? ` via ${seed.sources.join(", ")}` : ""}`,
  );
}
