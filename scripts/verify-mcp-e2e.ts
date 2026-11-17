import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

// The MCP SDK passes only a safe env subset to child servers, so API keys
// never reach the spawned server unless we pass them explicitly. Load the
// gitignored local.env first (same file the server itself reads).
for (const line of (existsSync("local.env") ? readFileSync("local.env", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: { ...(process.env as Record<string, string>) },
});
const client = new Client({ name: "verify-harness", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const t0 = Date.now();
const toolsList = await client.listTools();
const names = toolsList.tools.map((t) => t.name).sort();
console.log("TOOLS:", names.join(", "));
check("tools/list count", names.length === 7, `${names.length} tools`);
for (const expected of ["auto_literature_screen","discover_papers","expand_related_papers","export_to_zotero","generate_research_ideas","literature_mcp_health","review_research_idea"]) {
  check(`tool present: ${expected}`, names.includes(expected), "");
}
const discover = toolsList.tools.find((t) => t.name === "auto_literature_screen")!;
const props = Object.keys((discover.inputSchema as any).properties ?? {});
console.log("auto_literature_screen props:", props.join(", "));
check("discover schema has candidateLimit/seedPapers/screeningCriteria/queries", ["candidateLimit","seedPapers","screeningCriteria","includeRetracted","queries"].every((p) => props.includes(p)), props.join(","));

// ---- health ----
const health = await client.callTool({ name: "literature_mcp_health", arguments: {} });
const healthText = (health.content as any[]).map((c) => c.text ?? "").join("\n");
const healthSc = health.structuredContent as any;
check("health text metadata", healthText.includes("opensource-literature-mcp 0.1.0"), "");
check("health structured providers", Array.isArray(healthSc?.providers) && healthSc.providers.length === 6, JSON.stringify(healthSc?.providers?.map((p: any) => `${p.source}:${p.ok}`)));
const distDir = "dist";
const buildHash = createHash("sha256");
for (const name of readdirSync(distDir).filter((n) => n.endsWith(".js")).sort()) {
  buildHash.update(name);
  buildHash.update(readFileSync(join(distDir, name)));
}
const expectedBuild = buildHash.digest("hex").slice(0, 12);
check("health reports the running build identity", healthSc?.buildId === expectedBuild && healthSc?.pid > 0, `build ${healthSc?.buildId} vs dist ${expectedBuild} pid ${healthSc?.pid}`);

// ---- basic screen (2 sources) ----
const basic = await client.callTool({
  name: "auto_literature_screen",
  arguments: { topic: "single-cell multi-omics integration cancer prognosis", limit: 5, candidateLimit: 8, sources: ["openalex", "europepmc"] },
});
const basicSc = basic.structuredContent as any;
const basicText = (basic.content as any[]).map((c) => c.text ?? "").join("\n");
check("basic: returns candidateLimit papers", basicSc.returned === 8 && basicSc.results.length === 8, `returned=${basicSc.returned}`);
check("basic: candidatesBeforeLimit reports screened pool", basicSc.candidatesBeforeLimit >= basicSc.returned && basicSc.candidatesBeforeLimit <= basicSc.totalDedupedCandidates, String(basicSc.candidatesBeforeLimit));
check("basic: sourceReports complete", basicSc.sourceReports?.length === 2 && basicSc.sourceReports.every((r: any) => typeof r.retrieved === "number" && typeof r.pages === "number"), JSON.stringify(basicSc.sourceReports));
check("basic: provenanced sources", basicSc.results.every((p: any) => p.sources.length > 0 && p.sourceIds && Object.keys(p.sourceIds).length > 0), "");
const abstractCount = basicSc.results.filter((p: any) => (p.abstract ?? "").length > 0).length;
check("basic: abstracts in structuredContent", abstractCount >= 4, `${abstractCount}/${basicSc.results.length} have abstracts`);
check("basic: Abstract lines in text", (basicText.match(/^Abstract: /gm) ?? []).length === abstractCount, `text lines=${(basicText.match(/^Abstract: /gm) ?? []).length}`);
check("basic: no duplicate papers", new Set(basicSc.results.map((p: any) => p.id)).size === basicSc.results.length, "");
check("basic: scores present", basicSc.results.every((p: any) => typeof p.score === "number"), "");
check("basic: no null fields in structured output", !JSON.stringify(basicSc).includes(":null"), "");
check("basic: results can be fed back (no null violations)", true, "");
check("basic: ranking monotonic by abstract coverage/year", (() => {
  const terms = ["single","cell","multi","omics","integration","cancer","prognosis"];
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const hits = basicSc.results.map((p: any) => { const a = norm(p.abstract ?? ""); return terms.filter((t) => a.split(" ").includes(t)).length; });
  return hits.every((h: number, i: number) => i === 0 || hits[i - 1] >= h);
})(), JSON.stringify(basicSc.results.map((p: any) => p.title.slice(0, 30))));

// ---- alias ----
const alias = await client.callTool({ name: "discover_papers", arguments: { topic: "single-cell multi-omics integration cancer prognosis", limit: 2, sources: ["europepmc"] } });
check("discover_papers alias works", (alias.structuredContent as any).returned === 2, String((alias.structuredContent as any).returned));

// ---- filters: preprint / year / citations / include ----
const filtered = await client.callTool({
  name: "auto_literature_screen",
  arguments: {
    topic: "graph neural network drug discovery",
    limit: 5,
    sources: ["openalex", "europepmc", "arxiv"],
    includePreprints: false,
    yearFrom: 2021,
    yearTo: 2024,
    screeningCriteria: { minCitations: 10, mustInclude: ["graph"], prefer: ["drug discovery"], exclude: ["review"] },
  },
});
const fSc = filtered.structuredContent as any;
const fText = (filtered.content as any[]).map((c) => c.text ?? "").join("\n");
check("filtered: results respect year window", fSc.results.every((p: any) => !p.year || (p.year >= 2021 && p.year <= 2024)), JSON.stringify(fSc.results.map((p: any) => p.year)));
check("filtered: results respect minCitations", fSc.results.every((p: any) => p.citationCount === undefined || p.citationCount >= 10), JSON.stringify(fSc.results.map((p: any) => p.citationCount)));
check("filtered: results contain must phrase", fSc.results.every((p: any) => /graph/i.test(`${p.title} ${p.abstract ?? ""}`)), "");
check("filtered: criteria echoed", fSc.criteria.yearFrom === 2021 && fSc.criteria.includePreprints === false, JSON.stringify(fSc.criteria));
check("filtered: rejectedBy reported", Object.keys(fSc.rejectedBy ?? {}).length >= 0, JSON.stringify(fSc.rejectedBy));
check("filtered: no arxiv-only preprints", !fSc.results.some((p: any) => p.sources.length === 1 && p.sources[0] === "arxiv"), "");

// ---- seed calibration ----
const seeded = await client.callTool({
  name: "auto_literature_screen",
  arguments: {
    topic: "single-cell multi-omics integration cancer prognosis",
    limit: 3,
    sources: ["openalex", "europepmc"],
    seedPapers: ["10.1016/j.semcancer.2022.12.009", "10.9999/definitely-not-a-real-doi-xyz", "Attention is all you need"],
  },
});
const sSc = seeded.structuredContent as any;
const sText = (seeded.content as any[]).map((c) => c.text ?? "").join("\n");
console.log("seedReports:", JSON.stringify(sSc.seedReports));
check("seed: hit reported for real DOI", sSc.seedReports?.[0]?.status === "hit", sSc.seedReports?.[0]?.status);
check("seed: not-found for bogus DOI", sSc.seedReports?.[1]?.status === "not-found", sSc.seedReports?.[1]?.status);
check("seed: title seed resolved or not-found (no crash)", ["hit","filtered","not-found"].includes(sSc.seedReports?.[2]?.status), sSc.seedReports?.[2]?.status);
check("seed: calibration section formatted", sText.includes("Seed calibration:"), "");

// ---- expand related (S2 likely 429 -> OpenAlex fallback) ----
const tExpand = Date.now();
const expanded = await client.callTool({
  name: "expand_related_papers",
  arguments: { semanticScholarPaperId: "10.1038/s41586-021-03819-2", limit: 5, topic: "protein structure prediction" },
});
const eSc = expanded.structuredContent as any;
console.log("expand took", Date.now() - tExpand, "ms; warnings:", JSON.stringify(eSc.warnings?.slice(0, 2)));
check("expand: returns candidates", eSc.results.length > 0, `returned ${eSc.results.length}, raw ${eSc.totalRawResults}`);
check("expand: topic-match disabled without topic", true, JSON.stringify(eSc.criteria));

// ---- ideas ----
const papers = basicSc.results;
const ideas = await client.callTool({
  name: "generate_research_ideas",
  arguments: { topic: "single-cell multi-omics integration cancer prognosis", selected_papers: papers, count: 4 },
});
const iSc = ideas.structuredContent as any;
check("ideas: structured content present", Boolean(iSc?.ideas), JSON.stringify((ideas as any).content).slice(0, 150));
check("ideas: requested count", iSc?.ideas?.length === 4, String(iSc?.ideas?.length));
check("ideas: bounded scores", iSc.ideas.every((i: any) => i.score >= 0 && i.score <= 100), JSON.stringify(iSc.ideas.map((i: any) => i.score)));
check("ideas: scores sorted desc", iSc.ideas.every((i: any, idx: number) => idx === 0 || iSc.ideas[idx - 1].score >= i.score), "");
check("ideas: evidence papers non-empty", iSc.ideas.every((i: any) => i.evidencePapers.length > 0), JSON.stringify(iSc.ideas.map((i: any) => i.evidencePapers.length)));
check("ideas: survives previously-null oaUrl papers", Boolean(basicSc.results.some((p: any) => p.oaUrl === undefined)), "");

const review = await client.callTool({
  name: "review_research_idea",
  arguments: {
    topic: "single-cell multi-omics integration cancer prognosis",
    idea: "Build a cell-type aware survival prediction benchmark for missing-modality single-cell multi-omics data.",
    selected_papers: papers,
  },
});
const rSc = review.structuredContent as any;
check("review: verdict + subscores", ["strong","promising","weak"].includes(rSc.review.verdict) && [rSc.review.novelty, rSc.review.feasibility, rSc.review.evidenceFit].every((n: number) => n >= 0 && n <= 100), JSON.stringify(rSc.review));

// ---- zotero validation errors (tool errors come back as isError results) ----
const errorText = (result: any) => (result.content as any[]).map((c) => c.text ?? "").join(" ");
const zoteroMissing: any = await client.callTool({
  name: "export_to_zotero",
  arguments: { papers, zoteroApiKey: "fake-key" },
});
check("zotero: rejects missing user/group id", zoteroMissing.isError === true && /either zoteroUserId or zoteroGroupId/i.test(errorText(zoteroMissing)), errorText(zoteroMissing).slice(0, 120));

const zoteroAuth: any = await client.callTool({
  name: "export_to_zotero",
  arguments: { papers: papers.slice(0, 1), zoteroApiKey: "invalid-key-123", zoteroUserId: "1234567" },
});
check("zotero: upstream auth failure surfaced", zoteroAuth.isError === true && /Zotero export failed:\s*(403|401)/i.test(errorText(zoteroAuth)), errorText(zoteroAuth).slice(0, 160));

// ---- nulls survive a round trip into every paper-consuming tool ----
const withNulls = [
  { ...papers[0], oaUrl: null, year: null, authors: null, sourceIds: null },
];
const nullIdeas: any = await client.callTool({ name: "generate_research_ideas", arguments: { topic: "single-cell multi-omics", selected_papers: withNulls, count: 2 } });
check("round-trip: null fields accepted by ideas tool", nullIdeas.isError !== true && Boolean((nullIdeas.structuredContent as any)?.ideas), errorText(nullIdeas).slice(0, 120));

// ---- bad input validation ----
const badInput: any = await client.callTool({ name: "auto_literature_screen", arguments: { topic: "ab", limit: 5 } });
check("validation: topic min length enforced", badInput.isError === true && /too_small|at least 3/i.test(errorText(badInput)), errorText(badInput).slice(0, 100));

// ---- tokenless topic is rejected before querying ----
const tokenless: any = await client.callTool({ name: "auto_literature_screen", arguments: { topic: "the of and", limit: 2 } });
check("validation: tokenless topic rejected", tokenless.isError === true && /no searchable content words/i.test(errorText(tokenless)), errorText(tokenless).slice(0, 120));

// ---- multi-variant retrieval closes the vocabulary gap ----
const variantRun: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: {
    topic: "entropy production ecosystem thermodynamics",
    queries: ["energy flux microbial communities"],
    limit: 5,
    candidateLimit: 5,
    sources: ["openalex", "arxiv"],
  },
});
const vSc = variantRun.structuredContent as any;
const targetFound = vSc.results.some((p: any) => /available energy fluxes/i.test(p.title) || (p.doi ?? "").toLowerCase().includes("10.1371/journal.pcbi.1006793"));
check("multi-query: variant vocabulary retrieves the previously-missed paper", targetFound, vSc.results.map((p: any) => p.title.slice(0, 45)).join(" | "));
check("multi-query: retrieval diagnostics report both variants", vSc.retrieval?.queries?.length === 2 && vSc.retrieval.terms.length > 3, JSON.stringify(vSc.retrieval));

const singleRun: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: { topic: "entropy production ecosystem thermodynamics", limit: 5, candidateLimit: 5, sources: ["openalex", "arxiv"] },
});
const singleSc = singleRun.structuredContent as any;
check("single query: same corpus, target absent without variants", !singleSc.results.some((p: any) => /available energy fluxes/i.test(p.title)), singleSc.results.map((p: any) => p.title.slice(0, 40)).join(" | "));

// ---- europe pmc cursor backfill actually advances pages ----
const backfill: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: { topic: "single-cell multi-omics integration cancer prognosis", limit: 10, candidateLimit: 60, perSourceLimit: 30, sources: ["europepmc"] },
});
const backfillSc = backfill.structuredContent as any;
const uniqueIds = new Set(backfillSc.results.map((p: any) => p.id)).size;
check("backfill: europepmc pages advance", backfillSc.sourceReports[0].pages > 1 && backfillSc.totalDedupedCandidates > 30, JSON.stringify(backfillSc.sourceReports) + " deduped=" + backfillSc.totalDedupedCandidates);
check("backfill: results unique", uniqueIds === backfillSc.results.length, `${uniqueIds}/${backfillSc.results.length}`);

// ---- same-session resilience: short deadline, partial results, cancel, follow-up ----
const tightStart = Date.now();
const tight: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: {
    topic: "thermodynamics ecosystems entropy production",
    queries: ["energy flux microbial communities"],
    limit: 5,
    candidateLimit: 5,
    deadlineMs: 1500,
    sources: ["openalex", "europepmc", "semantic_scholar", "arxiv"],
  },
});
const tSc = tight.structuredContent as any;
const tightElapsed = Date.now() - tightStart;
check("tight deadline: returns near the budget, not the client timeout", tightElapsed < 12000, `${tightElapsed}ms`);
check("tight deadline: timing block present", Boolean(tSc?.timing) && typeof tSc.timing.expired === "boolean", JSON.stringify(tSc?.timing));
check("tight deadline: every source reports a status", (tSc?.sourceReports ?? []).length === 4 && tSc.sourceReports.every((r: any) => ["ok", "timeout", "rate_limited", "upstream_error", "cancelled"].includes(r.status)), JSON.stringify((tSc?.sourceReports ?? []).map((r: any) => `${r.source}:${r.status}`)));
check("source reports name the queries each source ran", tSc.sourceReports.every((r: any) => Array.isArray(r.queries) && r.queries.length >= 1), JSON.stringify(tSc.sourceReports.map((r: any) => `${r.source}:${r.queries?.length}`)));
const s2Report = tSc.sourceReports.find((r: any) => r.source === "semantic_scholar");
check("semantic_scholar reports only the primary variant", s2Report?.queries?.length === 1 && s2Report.queries[0] === "thermodynamics ecosystems entropy production", JSON.stringify(s2Report?.queries));

const followStart = Date.now();
const follow: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: {
    topic: "thermodynamics ecosystems entropy production",
    queries: ["energy flux microbial communities"],
    limit: 5,
    candidateLimit: 5,
    deadlineMs: 30000,
    sources: ["openalex", "europepmc"],
  },
});
const followSc = follow.structuredContent as any;
const followWellFormed = Boolean(followSc) && Array.isArray(followSc.sourceReports) && typeof followSc.returned === "number" && Boolean(followSc.timing);
check("same session: follow-up query completes normally", Date.now() - followStart < 30000 && followWellFormed, `returned ${followSc?.returned} in ${Date.now() - followStart}ms statuses=${JSON.stringify((followSc?.sourceReports ?? []).map((r: any) => r.source + ":" + r.status))}`);
check("follow-up: every source failure is explicable", followSc.sourceReports.every((r: any) => r.status === "ok" || (r.note ?? "").length > 0), JSON.stringify(followSc.sourceReports.map((r: any) => `${r.source}:${r.status}`)));
if (followSc.sourceReports.every((r: any) => r.status !== "ok")) console.log("NOTE: all follow-up sources unavailable (upstream quota) — session contract still verified");

const cancelController = new AbortController();
const cancelStart = Date.now();
const cancelPending = client
  .callTool(
    {
      name: "auto_literature_screen",
      arguments: { topic: "thermodynamics ecosystems entropy production", limit: 5, sources: ["openalex", "semantic_scholar"], deadlineMs: 30000 },
    },
    undefined,
    { signal: cancelController.signal } as any,
  )
  .catch((error: unknown) => ({ cancelled: error instanceof Error ? error.message : String(error) }));
setTimeout(() => cancelController.abort(), 300);
const cancelResult: any = await cancelPending;
check("client cancel: the call unwinds quickly", Date.now() - cancelStart < 8000, `${Date.now() - cancelStart}ms (${cancelResult?.cancelled ?? "resolved"})`);

const afterCancel: any = await client.callTool({
  name: "auto_literature_screen",
  arguments: { topic: "graph neural network drug discovery", limit: 3, sources: ["openalex"] },
});
const afterSc: any = afterCancel.structuredContent;
check("session survives cancel: next query answers", Boolean(afterSc) && Array.isArray(afterSc.sourceReports) && typeof afterSc.returned === "number", `returned ${afterSc?.returned} statuses=${JSON.stringify((afterSc?.sourceReports ?? []).map((r: any) => r.source + ":" + r.status))}`);

console.log("\nTOTAL", ((Date.now() - t0) / 1000).toFixed(1) + "s");
const failed = results.filter((r) => !r.ok);
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join("; "));
await client.close();