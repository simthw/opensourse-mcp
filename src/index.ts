#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatScreenedResult } from "./format.js";
import { discoverAndScreen, expandRelated, type CallCtx, type DiscoverInput } from "./workflow.js";
import type { Paper, ScreenedResult, SourceName } from "./types.js";
import { exportToZotero } from "./providers/zotero.js";
import { generateResearchIdeas, reviewResearchIdea } from "./researchIdeas.js";
import { activeCooldowns, fetchWithTimeout } from "./http.js";
import { normalizePaper } from "./utils.js";
import { configuredDeadlineMs, Deadline } from "./deadline.js";
import { logEvent, newRequestId, safeUrl } from "./log.js";

/**
 * Identity of the code actually running: a hash of this module file. A GUI
 * that keeps an old stdio process alive is the classic incident here, so
 * every health report names its build.
 */
const buildId = (() => {
  try {
    // Hash every built module in this directory, not just the entry file:
    // a stale workflow.js behind a fresh index.js is exactly the incident
    // this id exists to detect.
    const dir = dirname(fileURLToPath(import.meta.url));
    const hash = createHash("sha256");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
      hash.update(name);
      hash.update(readFileSync(join(dir, name)));
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
})();
const processStartedAt = Date.now();

/**
 * Optional `local.env` (gitignored) supplies API keys to any entry point —
 * dev scripts, tests, and stdio spawns whose client stripped the environment
 * (the MCP SDK passes only a safe env subset to child servers). Values
 * already present in the environment win over the file.
 */
(function loadLocalEnv() {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "local.env"),
    join(process.cwd(), "local.env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (process.env[match[1]] === undefined && value.length > 0) {
        process.env[match[1]] = value;
      }
    }
    break;
  }
})();

const sourceSchema = z.enum(["openalex", "europepmc", "semantic_scholar", "arxiv", "pubmed", "crossref"]);

const screeningCriteriaSchema = z.object({
  mustInclude: z.array(z.string()).optional(),
  prefer: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  minCitations: z.number().int().min(0).optional(),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  includePreprints: z.boolean().optional(),
});

/**
 * Papers accepted back from a caller (ideas / review / Zotero). Optional
 * fields are `nullish`, not just optional: a caller may round-trip a record
 * whose provider emitted `null` for a missing value, and a strict
 * `.optional()` would reject the whole request. Every handler normalises the
 * input through normalizePaper before using it.
 */
const paperSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()).nullish(),
  year: z.number().nullish(),
  publishedDate: z.string().nullish(),
  venue: z.string().nullish(),
  doi: z.string().nullish(),
  arxivId: z.string().nullish(),
  openalexId: z.string().nullish(),
  semanticScholarId: z.string().nullish(),
  pmid: z.string().nullish(),
  url: z.string().nullish(),
  oaUrl: z.string().nullish(),
  openAccess: z.boolean().nullish(),
  abstract: z.string().nullish(),
  citationCount: z.number().nullish(),
  influentialCitationCount: z.number().nullish(),
  sources: z.array(sourceSchema).nullish(),
  sourceIds: z.record(z.string()).nullish(),
  score: z.number().nullish(),
  reasons: z.array(z.string()).nullish(),
});

function normalizedPapers(papers: Array<z.infer<typeof paperSchema>>): Paper[] {
  return papers.map((paper) => normalizePaper(paper as unknown as Paper));
}

const discoverSchema = {
  topic: z.string().min(3).describe("Research topic or query."),
  explain: z
    .boolean()
    .optional()
    .describe(
      "Debug: also return rejectedDetails — one line per excluded candidate with the rule that fired (year, min-citations, excluded-term, missing-must, preprint, below-relevance) and why, so screening conditions can be adjusted. Off by default to keep the payload small.",
    ),
  deadlineMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .describe(
      "Total wall-clock budget for this call in ms. Defaults to the server budget (env LITERATURE_MCP_DEADLINE_MS, 50000) — set it below your own client timeout. Queuing, retries, requests, body reads and paging share it; on expiry the call returns partial results with per-source status instead of blocking.",
    ),
  queries: z
    .array(z.string().min(3))
    .max(5)
    .optional()
    .describe(
      "Alternative phrasings of the same concept (synonyms, other vocabulary, or a narrower/wider wording). Each variant is ANDed internally and the variants are ORed at OpenAlex, Europe PMC, arXiv, PubMed and Crossref (Semantic Scholar receives only the primary topic); screening accepts a paper matching ANY variant's terms. Supply 3-5 variants for non-trivial searches: a single AND query cannot retrieve a paper that never uses those exact words (e.g. topic 'entropy production ecosystems' misses 'available energy fluxes drive a transition in microbial communities').",
    ),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      "Requested result count and the default for candidateLimit. The response contains up to candidateLimit papers.",
    ),
  candidateLimit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "How many ranked candidates to return for the caller's own topical judgement. Defaults to limit. Set it higher than limit to give the calling model a wider net; abstracts are included (truncated to 150 words) so relevance can be judged from content, not just titles.",
    ),
  perSourceLimit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Records to request per source page. Capped at 50: beyond the relevance head the results become noise."),
  sources: z
    .array(sourceSchema)
    .default(["openalex", "europepmc", "semantic_scholar", "arxiv", "pubmed", "crossref"])
    .describe("Sources to search. All six are searched by default; each is capped and budgeted independently."),
  includePreprints: z.boolean().default(true),
  includeRetracted: z
    .boolean()
    .optional()
    .describe("Default false: retractions are excluded server-side. Set true to include retracted papers."),
  seedPapers: z
    .array(z.string())
    .optional()
    .describe(
      "Seed papers (DOI, arXiv ID, or full title) to verify coverage. Each seed is reported as hit (merged ID), filtered (exclusion code), or not-found.",
    ),
  screeningCriteria: screeningCriteriaSchema.optional(),
  semanticScholarApiKey: z.string().optional(),
};

const server = new McpServer({
  name: "opensource-literature-mcp",
  version: "0.1.0",
});

function toolResult(result: ScreenedResult) {
  return {
    content: [{ type: "text" as const, text: formatScreenedResult(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

interface ProviderHealth {
  source: SourceName;
  ok: boolean;
  status?: number;
  statusText?: string;
  error?: string;
  durationMs?: number;
}

/** Upstream probe: hard 4s cap, no retries, results measured per source. */
async function checkProvider(source: SourceName): Promise<ProviderHealth> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(healthUrl(source), {
      headers: healthHeaders(source),
      timeoutMs: 4000,
      retries: 0,
      cacheTtlMs: 30_000,
    });
    return {
      source,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      source,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function checkProviders(): Promise<ProviderHealth[]> {
  // Concurrent and individually capped: a dead upstream cannot make the
  // health check itself slow (it used to probe four sources serially).
  const sources: SourceName[] = ["openalex", "europepmc", "semantic_scholar", "arxiv", "pubmed", "crossref"];
  return Promise.all(sources.map((source) => checkProvider(source)));
}

function healthUrl(source: SourceName): string {
  if (source === "openalex") {
    const params = new URLSearchParams({
      search: "machine learning",
      per_page: "1",
      mailto: process.env.OPENALEX_MAILTO?.trim() || "anonymous@example.com",
    });
    const apiKey = process.env.OPENALEX_API_KEY?.trim();
    if (apiKey) params.set("api_key", apiKey);
    return `https://api.openalex.org/works?${params}`;
  }

  if (source === "europepmc") {
    const params = new URLSearchParams({
      query: "machine learning",
      format: "json",
      resultType: "core",
      pageSize: "1",
    });
    return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;
  }

  if (source === "semantic_scholar") {
    const params = new URLSearchParams({
      query: "machine learning",
      limit: "1",
      fields: "paperId,title",
    });
    return `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
  }

  if (source === "pubmed") {
    const params = new URLSearchParams({
      db: "pubmed",
      term: "machine learning[tiab]",
      retmode: "json",
      retmax: "1",
    });
    return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`;
  }

  if (source === "crossref") {
    const params = new URLSearchParams({
      "query.bibliographic": "machine learning",
      rows: "1",
      select: "DOI",
    });
    return `https://api.crossref.org/works?${params}`;
  }

  const params = new URLSearchParams({
    search_query: "all:machine learning",
    start: "0",
    max_results: "1",
  });
  return `https://export.arxiv.org/api/query?${params}`;
}

function healthHeaders(source: SourceName): Record<string, string> {
  if (source === "openalex") {
    const contact = process.env.OPENALEX_MAILTO?.trim() || "anonymous@example.com";
    return { "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contact})` };
  }

  if (source === "semantic_scholar" && process.env.SEMANTIC_SCHOLAR_API_KEY) {
    return { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY };
  }

  return {};
}

/**
 * Zotero accepts a batch partially: some items get keys, others come back under
 * `failed`. Report both counts (and the first few failures) instead of a flat
 * "Exported N papers" that hides rejected items.
 */
function formatZoteroSummary(
  result: { imported: number; failed: Array<{ index: number; code?: string; message?: string }>; endpoint: string },
  submitted: number,
): string {
  const base = `Exported ${result.imported} of ${submitted} papers to Zotero via ${result.endpoint}.`;
  if (result.failed.length === 0) return base;
  const detail = result.failed
    .slice(0, 3)
    .map((item) => `#${item.index}${item.code ? ` (${item.code})` : ""}${item.message ? ` ${item.message}` : ""}`)
    .join("; ");
  const more = result.failed.length > 3 ? `; +${result.failed.length - 3} more` : "";
  return `${base} ${result.failed.length} failed: ${detail}${more}.`;
}

function formatProviderHealth(checks: ProviderHealth[]): string {
  return checks
    .map((check) => {
      const status = check.status ? `${check.status} ${check.statusText ?? ""}`.trim() : check.error ?? "unknown";
      return `${check.source}: ${check.ok ? "ok" : "failed"} (${status}) ${check.durationMs ?? 0}ms`;
    })
    .join("\n");
}

/** Per-call context: the client's cancel signal, the total budget, an id. */
function callCtxFrom(extra?: { signal?: AbortSignal }): CallCtx {
  return {
    signal: extra?.signal,
    deadlineMs: configuredDeadlineMs(),
    requestId: newRequestId(),
  };
}

const discoverHandler = async (args: DiscoverInput, extra?: { signal?: AbortSignal }) =>
  toolResult(await discoverAndScreen(args, callCtxFrom(extra)));

/**
 * Shared description for the search tools. The ordering contract is stated
 * explicitly so the calling model knows it must do the topical judgement
 * itself rather than trusting the returned order.
 */
const SEARCH_TOOL_DESCRIPTION = [
  "Search OpenAlex, Europe PMC, Semantic Scholar, and arXiv, then internally merge, dedupe, apply rule-based screening, and return candidates with their abstracts.",
  "",
  "RETRIEVAL IS LEXICAL: each query variant is ANDed word-by-word inside a provider, and the variants you pass in `queries` are ORed together at OpenAlex, Europe PMC, arXiv, PubMed and Crossref (Semantic Scholar has no boolean query syntax and receives only the primary topic — see `sourceReports[].queries` for what each source actually ran). A single variant therefore silently misses on-topic papers that use different vocabulary, so pass 3-5 paraphrases whenever the concept has competing wordings (e.g. 'entropy production ecosystems' + 'energy flux microbial communities'). The response reports the variants and screening terms that actually ran under `retrieval`.",
  "",
  "IMPORTANT: this tool does NOT judge topical relevance. It returns a candidate pool ordered by neutral, deterministic rules only:",
  "(1) how many topic words appear in the ABSTRACT, (2) publication year (newest first), (3) citation count, (4) title.",
  "Because the ordering is not a relevance model, off-topic papers that happen to repeat the topic words (including pseudoscientific or unrelated items) can rank highly, and genuinely relevant papers can rank lower.",
  "",
  "READ EACH ABSTRACT and decide for yourself whether it actually matches the research question; do not present the returned order as a relevance ranking.",
  "Titles alone are insufficient: a paper's title rarely states what it actually does, so judge from the Abstract line.",
  "",
  "Also returned: per-source reports (status ok/timeout/rate_limited/upstream_error, available/retrieved/pages, queries run, duration), rejection statistics by exclusion code, optional seed-paper calibration (hit / filtered / not-found), and a timing block.",
  "TIME BUDGET: one call has a hard wall-clock deadline (default 50s, env LITERATURE_MCP_DEADLINE_MS). Slow or rate-limited sources are dropped rather than blocking the others — the response returns whatever arrived in time with per-source status, and a long upstream Retry-After becomes a shared cooldown that later calls report immediately instead of re-trying early.",
  "If the caller needs a wider net to choose from, raise candidateLimit above limit.",
].join("\n");

server.registerTool(
  "auto_literature_screen",
  {
    title: "Auto Literature Screen",
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: discoverSchema,
  },
  discoverHandler,
);

server.registerTool(
  "discover_papers",
  {
    title: "Discover Papers",
    description: `Alias for auto_literature_screen.\n\n${SEARCH_TOOL_DESCRIPTION}`,
    inputSchema: discoverSchema,
  },
  discoverHandler,
);

server.registerTool(
  "expand_related_papers",
  {
    title: "Expand Related Papers",
    description:
      "Use Semantic Scholar recommendations for a seed paper, then return related candidates with their abstracts. If Semantic Scholar rate-limits the request, falls back to the seed record's related_works from OpenAlex.\n\nIMPORTANT: like auto_literature_screen, this tool does NOT judge topical relevance. The same neutral ordering applies (abstract topic coverage, then year, then citations). Read each Abstract and decide relevance yourself.",
    inputSchema: {
      semanticScholarPaperId: z.string().min(1),
      topic: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      screeningCriteria: screeningCriteriaSchema.optional(),
      semanticScholarApiKey: z.string().optional(),
    },
  },
  async (args, extra?: { signal?: AbortSignal }) => {
    const result = await expandRelated(args, callCtxFrom(extra));
    return toolResult(result);
  },
);

server.registerTool(
  "literature_mcp_health",
  {
    title: "Literature MCP Health",
    description: "Return server metadata, configured optional API keys, and live upstream provider status.",
  },
  async () => {
    // Local status is available before the upstream probes run: this tells
    // you WHICH build the client is actually talking to (the classic
    // incident: the GUI keeps an old stdio process alive).
    const local = {
      name: "opensource-literature-mcp",
      version: "0.1.0",
      buildId,
      pid: process.pid,
      node: process.version,
      uptimeMs: Date.now() - processStartedAt,
      deadlineMs: configuredDeadlineMs(),
      cooldowns: activeCooldowns().map((entry) => ({
        scope: entry.scope.split(" headers:")[0],
        remainingMs: entry.remainingMs,
      })),
      semanticScholarApiKeyConfigured: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY),
      openAlexApiKeyConfigured: Boolean(process.env.OPENALEX_API_KEY),
    };
    logEvent("health.start", { buildId, pid: process.pid });
    const providers = await checkProviders();
    return {
      content: [
        {
          type: "text",
          text: [
            "opensource-literature-mcp 0.1.0",
            `build: ${buildId} | pid: ${process.pid} | uptime: ${Math.round((Date.now() - processStartedAt) / 1000)}s | node: ${process.version}`,
            `budget: call deadline ${local.deadlineMs}ms (LITERATURE_MCP_DEADLINE_MS)`,
            `Semantic Scholar API key configured: ${local.semanticScholarApiKeyConfigured ? "yes" : "no"}`,
            `OpenAlex API key configured: ${local.openAlexApiKeyConfigured ? "yes" : "no"}`,
            local.cooldowns.length > 0
              ? `cooldowns: ${local.cooldowns.map((entry) => `${entry.scope} ${Math.ceil(entry.remainingMs / 1000)}s`).join(", ")}`
              : "cooldowns: none",
            "Provider checks (concurrent, 4s cap each):",
            formatProviderHealth(providers),
          ].join("\n"),
        },
      ],
      structuredContent: { ...local, providers },
    };
  },
);

server.registerTool(
  "export_to_zotero",
  {
    title: "Export To Zotero",
    description:
      "Export selected final papers to a Zotero user or group library. Intended for results from auto_literature_screen.",
    inputSchema: {
      papers: z.array(paperSchema).min(1).max(100),
      zoteroApiKey: z.string().min(1),
      zoteroUserId: z.string().optional(),
      zoteroGroupId: z.string().optional(),
    },
  },
  async (args, extra?: { signal?: AbortSignal }) => {
    const callCtx = callCtxFrom(extra);
    const deadline = new Deadline(callCtx.deadlineMs ?? configuredDeadlineMs(), callCtx.signal);
    const result = await exportToZotero(
      {
        papers: normalizedPapers(args.papers),
        apiKey: args.zoteroApiKey,
        userId: args.zoteroUserId,
        groupId: args.zoteroGroupId,
      },
      { deadline, logTag: callCtx.requestId },
    ).finally(() => deadline.dispose());

    return {
      content: [
        {
          type: "text" as const,
          text: formatZoteroSummary(result, args.papers.length),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "generate_research_ideas",
  {
    title: "Generate Research Ideas",
    description:
      "Produce heuristic, keyword-based research-idea scaffolding from a topic and selected papers. Ideas are derived from term overlap and research-gap templates, not from a language model, and scores are relative heuristics. Does not run experiments or execute code.",
    inputSchema: {
      topic: z.string().min(3),
      selected_papers: z.array(paperSchema).min(1).max(100),
      count: z.number().int().min(1).max(20).default(5),
      candidateMethods: z
        .array(z.string())
        .optional()
        .describe("Optional method phrases to look for in the selected papers (override the biomedical defaults)."),
      focusGaps: z
        .array(z.string())
        .optional()
        .describe("Optional research-gap phrases to consider alongside the generic defaults."),
    },
  },
  async (args) => {
    const ideas = generateResearchIdeas(args.topic, normalizedPapers(args.selected_papers), args.count, {
      candidateMethods: args.candidateMethods,
      focusGaps: args.focusGaps,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: ideas
            .map(
              (idea, index) =>
                `${index + 1}. ${idea.title}\nHypothesis: ${idea.hypothesis}\nEvidence: ${idea.evidencePapers.join("; ")}\nRisks: ${idea.risks.join("; ")}`,
            )
            .join("\n\n"),
        },
      ],
      structuredContent: { topic: args.topic, ideas },
    };
  },
);

server.registerTool(
  "review_research_idea",
  {
    title: "Review Research Idea",
    description:
      "Heuristically review a proposed research idea against selected papers, scoring novelty, feasibility, and literature support from keyword overlap. Scores are relative heuristics, not a language-model judgment.",
    inputSchema: {
      topic: z.string().min(3),
      idea: z.string().min(10),
      selected_papers: z.array(paperSchema).min(1).max(100),
    },
  },
  async (args) => {
    const review = reviewResearchIdea(args.topic, args.idea, normalizedPapers(args.selected_papers));
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Verdict: ${review.verdict} (${review.score}/100)`,
            `Novelty: ${review.novelty}/100`,
            `Feasibility: ${review.feasibility}/100`,
            `Evidence fit: ${review.evidenceFit}/100`,
            `Concerns: ${review.concerns.join("; ")}`,
            `Supporting papers: ${review.supportingPapers.join("; ")}`,
            `Suggested refinement: ${review.suggestedRefinement}`,
          ].join("\n"),
        },
      ],
      structuredContent: { topic: args.topic, idea: args.idea, review },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
