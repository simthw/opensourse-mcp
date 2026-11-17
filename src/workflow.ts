import { searchArxivPage } from "./providers/arxiv.js";
import { searchEuropePmcPage } from "./providers/europepmc.js";
import { searchCrossrefPage } from "./providers/crossref.js";
import { searchPubMedPage } from "./providers/pubmed.js";
import {
  fetchOpenAlexByIds,
  fetchOpenAlexWorkByDoi,
  searchOpenAlexPage,
} from "./providers/openalex.js";
import {
  getSemanticScholarPaperExternalIds,
  getSemanticScholarRecommendations,
  searchSemanticScholarPage,
} from "./providers/semanticScholar.js";
import { screenAndRankDetailed } from "./screening.js";
import { buildQueryPlan } from "./queryPlan.js";
import {
  configuredDeadlineMs,
  configuredSourceBudgetMs,
  Deadline,
  type RequestCtx,
} from "./deadline.js";
import { classifyFailure } from "./http.js";
import { logEvent, newRequestId } from "./log.js";
import type {
  ExclusionCode,
  Paper,
  ProviderPage,
  ScreenedResult,
  ScreeningCriteria,
  SearchOptions,
  SeedReport,
  SourceName,
  SourceReport,
} from "./types.js";
import { canonicalDoi, matchSeedPaper, mergePapers } from "./utils.js";

export interface DiscoverInput {
  topic: string;
  yearFrom?: number;
  yearTo?: number;
  limit?: number;
  /**
   * How many screened candidates to hand back for the caller's own topical
   * judgement. Defaults to `limit` (backward compatible). Set higher than
   * `limit` to give a calling model a wider net to choose from; the MCP layer
   * returns them ranked but does not judge relevance itself.
   */
  candidateLimit?: number;
  perSourceLimit?: number;
  sources?: SourceName[];
  includePreprints?: boolean;
  /**
   * Default false: retractions are filtered out server-side (OpenAlex).
   * Set true to retrieve them again.
   */
  includeRetracted?: boolean;
  /**
   * Optional seed papers (DOI / arXiv ID / full title). Each seed is reported
   * as hit (with merged ID), filtered (with exclusion code), or not-found, so
   * the caller can tell retrieval-layer gaps from screening-layer gaps.
   */
  seedPapers?: string[];
  /**
   * Per-call wall-clock budget in ms. Overrides the server default
   * (LITERATURE_MCP_DEADLINE_MS, 50s); set it below your own client timeout.
   * On expiry the call returns partial results with per-source status.
   */
  deadlineMs?: number;
  /**
   * Debug: include per-candidate rejection explanations (which rule fired and
   * why), so screening conditions can be adjusted instead of guessed.
   */
  explain?: boolean;
  /**
   * Alternative phrasings of the topic. Retrieval ORs the variants (ANDing the
   * words inside each), and screening accepts a paper matching ANY variant's
   * terms. Use it to cover synonym families: a single AND query cannot find a
   * paper that words the same concept differently.
   */
  queries?: string[];
  screeningCriteria?: ScreeningCriteria;
  semanticScholarApiKey?: string;
}

export async function expandRelated(
  input: {
    semanticScholarPaperId: string;
    topic?: string;
    limit?: number;
    screeningCriteria?: ScreeningCriteria;
    semanticScholarApiKey?: string;
  },
  callCtx: CallCtx = {},
): Promise<ScreenedResult> {
  const requestId = callCtx.requestId ?? newRequestId();
  const deadline = new Deadline(callCtx.deadlineMs ?? configuredDeadlineMs(), callCtx.signal);
  const startedAt = Date.now();
  try {
    return await expandWithinBudget(input, { deadline, requestId, sourceBudgetMs: configuredSourceBudgetMs(), startedAt });
  } finally {
    deadline.dispose();
  }
}

async function expandWithinBudget(input: {
  semanticScholarPaperId: string;
  topic?: string;
  limit?: number;
  screeningCriteria?: ScreeningCriteria;
  semanticScholarApiKey?: string;
}, run: RunCtx): Promise<ScreenedResult> {
  const { deadline, requestId } = run;
  const ctx: RequestCtx = { deadline, logTag: `${requestId} expand` };
  const topic = input.topic ?? input.semanticScholarPaperId;
  const limit = input.limit ?? 20;
  const warnings: string[] = [];
  // The caller's criteria plus the effective relevance-floor switch, so the
  // response says what actually ran instead of echoing the raw input.
  const effectiveCriteria: ScreeningCriteria = { ...(input.screeningCriteria ?? {}) };
  if (!input.topic) effectiveCriteria.requireTopicMatch = false;
  let papers: Paper[] = [];

  try {
    papers = await getSemanticScholarRecommendations(
      input.semanticScholarPaperId,
      Math.max(limit * 3, 30),
      input.semanticScholarApiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY,
      ctx,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Degradation chain: when S2 recommendations fail (typically 429 or 404),
    // fall back to the seed record's related_works from OpenAlex.
    warnings.push(`semantic_scholar: ${message}`);
    try {
      // The fallback talks to OpenAlex, so it must use the OpenAlex key, not
      // the caller's Semantic Scholar key (a foreign key yields 401).
      papers = await relatedWorksFromOpenAlex(
        input.semanticScholarPaperId,
        limit,
        process.env.OPENALEX_API_KEY?.trim() || undefined,
        input.semanticScholarApiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY,
        ctx,
      );
      if (papers.length === 0) {
        warnings.push("openalex fallback: seed record or related works not found");
      }
    } catch (fallbackError) {
      warnings.push(
        `openalex fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }

  const deduped = mergePapers(papers);
  // Without an explicit topic, the fallback topic is the seed ID itself —
  // not a meaningful topic string, so the relevance floor is already off.
  const screen = screenAndRankDetailed(topic, deduped, effectiveCriteria, limit);
  warnings.push(...screen.warnings);

  if (deadline.expired()) {
    warnings.push(`deadline exceeded after ${Date.now() - run.startedAt}ms; partial results returned`);
  }
  logEvent("expand.end", {
    requestId,
    elapsedMs: Date.now() - run.startedAt,
    returned: screen.selected.length,
    expired: deadline.expired(),
  });

  return {
    topic,
    criteria: effectiveCriteria,
    totalRawResults: papers.length,
    totalDedupedCandidates: deduped.length,
    returned: screen.selected.length,
    results: screen.selected,
    warnings,
    rejectedBy: screen.rejectedBy,
    timing: {
      elapsedMs: Date.now() - run.startedAt,
      deadlineMs: deadline.totalMs,
      expired: deadline.expired(),
    },
  };
}

/** Additional pages fetched per source when the screen falls short of limit. */
const MAX_BACKFILL_PAGES = 2;
/** Never start another page unless at least this much budget is left. */
const MIN_BACKFILL_BUDGET_MS = 1_500;
/**
 * Ceiling on how many records to pull from one source in a single page. Beyond
 * the relevance-ranked head, keyword-AND results degrade into noise, so a
 * larger pool buys quantity at the cost of quality.
 */
const MAX_PER_SOURCE_FETCH = 50;
/** Hard caps on the raw candidate pool per source. */
const POOL_CAPS: Record<SourceName, number> = {
  openalex: 200,
  europepmc: 200,
  semantic_scholar: 100,
  arxiv: 100,
  pubmed: 200,
  crossref: 200,
};

const DEFAULT_SOURCES: SourceName[] = [
  "openalex",
  "europepmc",
  "semantic_scholar",
  "arxiv",
  "pubmed",
  "crossref",
];

/** Everything one tool call needs to pass down: cancel signal + budget. */
export interface CallCtx {
  /** MCP cancellation signal; aborts every fetch, wait and queue in the call. */
  signal?: AbortSignal;
  /** Total wall-clock budget (default: configuredDeadlineMs()). */
  deadlineMs?: number;
  /** Correlation id for stderr diagnostics. */
  requestId?: string;
}

interface SourceState {
  pages: ProviderPage[];
  error?: string;
  failure?: string;
  startedAt: number;
  durationMs?: number;
  queries: string[];
}

/** What a source actually ran: S2 has no boolean queries, so it gets the primary variant only. */
function queriesFor(source: SourceName, plan: { variants: string[] }): string[] {
  return source === "semantic_scholar" ? plan.variants.slice(0, 1) : plan.variants;
}

export async function discoverAndScreen(
  input: DiscoverInput,
  callCtx: CallCtx = {},
): Promise<ScreenedResult> {
  // One call, one budget: queuing, backoff, requests, body reads and paging
  // all draw from it, and the deadline aborts the shared signal so a dead
  // call stops consuming upstream quota the moment the client is gone.
  const requestId = callCtx.requestId ?? newRequestId();
  const deadline = new Deadline(
    input.deadlineMs ?? callCtx.deadlineMs ?? configuredDeadlineMs(),
    callCtx.signal,
  );
  const sourceBudgetMs = Math.min(configuredSourceBudgetMs(), deadline.totalMs);
  const startedAt = Date.now();
  try {
    return await discoverWithinBudget(input, { deadline, requestId, sourceBudgetMs, startedAt });
  } finally {
    deadline.dispose();
  }
}

interface RunCtx {
  deadline: Deadline;
  requestId: string;
  sourceBudgetMs: number;
  startedAt: number;
}

async function discoverWithinBudget(input: DiscoverInput, run: RunCtx): Promise<ScreenedResult> {
  const { deadline, requestId, sourceBudgetMs, startedAt } = run;
  // The concept is the union of the topic and its variants. A set made only of
  // stopwords ("the of and") carries no searchable meaning: OpenAlex would run
  // an unfiltered query and return an arbitrary slice of its index, so fail
  // loudly instead.
  const plan = buildQueryPlan(input.topic, input.queries ?? []);
  if (plan.terms.length === 0) {
    throw new Error(
      `Topic "${input.topic}" has no searchable content words; add a more specific topic or a "queries" variant.`,
    );
  }
  const limit = input.limit ?? 20;
  // Screening pool: how many ranked candidates to retain for the caller.
  // `limit` is what the caller asked to see; `candidateLimit` may be larger so
  // a calling model can do its own topical filtering over a wider net.
  const candidateLimit = Math.max(input.candidateLimit ?? limit, limit);
  const criteria: ScreeningCriteria = {
    ...input.screeningCriteria,
    yearFrom: input.screeningCriteria?.yearFrom ?? input.yearFrom,
    yearTo: input.screeningCriteria?.yearTo ?? input.yearTo,
    includePreprints: input.screeningCriteria?.includePreprints ?? input.includePreprints ?? true,
  };
  const sources = input.sources ?? DEFAULT_SOURCES;
  // Retrieval volume is intentionally decoupled from candidateLimit: keyword
  // AND search has a long tail, so fetching the 100th relevance-ranked record
  // adds noise, not value. Cap the per-source fetch regardless of how many
  // candidates the caller wants to inspect.
  const options: SearchOptions = {
    topic: input.topic,
    yearFrom: criteria.yearFrom,
    yearTo: criteria.yearTo,
    limit: Math.min(input.perSourceLimit ?? Math.max(limit * 3, 30), MAX_PER_SOURCE_FETCH),
    sources,
    includePreprints: criteria.includePreprints ?? true,
    includeRetracted: input.includeRetracted ?? false,
    minCitations: criteria.minCitations,
    variants: plan.variants,
    semanticScholarApiKey: input.semanticScholarApiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY,
  };

  const warnings: string[] = [];
  const states = new Map<SourceName, SourceState>();

  // Fetch every source concurrently: each provider is independent and the
  // slowest one (often arXiv, or a rate-limited S2) must not block the rest.
  // Results are collected per source, so ordering and error attribution are
  // unchanged.
  logEvent("search.start", {
    requestId,
    topic: input.topic,
    sources: sources.join(","),
    variants: plan.variants.length,
    deadlineMs: deadline.totalMs,
  });

  // Fetch every source concurrently: each provider is independent and the
  // slowest one (often arXiv, or a rate-limited S2) must not block the rest.
  // Every task is deadline-bounded, so this settles by the deadline at the
  // latest and the pages fetched so far are kept.
  await Promise.all(
    sources.map(async (source) => {
      const state: SourceState = {
        pages: [],
        startedAt: Date.now(),
        queries: queriesFor(source, plan),
      };
      states.set(source, state);
      const ctx: RequestCtx = { deadline, logTag: `${requestId} ${source} p1` };
      try {
        state.pages.push(await searchSourcePage(source, options, undefined, ctx));
      } catch (error) {
        state.failure = classifyFailure(error);
        state.error = describeSourceError(
          source,
          error instanceof Error ? error.message : String(error),
        );
        warnings.push(`${source}: ${state.error}`);
      } finally {
        state.durationMs = Date.now() - state.startedAt;
      }
    }),
  );

  const collect = () => {
    const raw = [...states.values()].flatMap((state) => state.pages.flatMap((page) => page.papers));
    const deduped = mergePapers(raw);
    // Screen against the union of every variant's terms: a paper found through
    // an alternative phrasing must not be rejected for lacking the primary
    // topic's wording.
    const screen = screenAndRankDetailed(input.topic, deduped, criteria, candidateLimit, {
      terms: plan.terms,
      excludeContext: plan.variants.join(" "),
    });
    return { raw, deduped, screen };
  };

  let collection = collect();

  // Count-reconcile backfill: when screening falls short of the limit, page
  // sources again within hard caps (per source <=2 extra pages, pool
  // <=200/100), so the shortfall comes from the corpus and not from a single
  // relevance-truncated page.
  //
  // Paging must stay sequential per source (a page needs the previous page's
  // cursor/offset), but sources are independent of each other, so one
  // backfill round fetches each eligible source's next page concurrently and
  // only then re-screens.
  while (
    collection.screen.selected.length < candidateLimit &&
    sources.some((source) => canBackfill(source, states, run))
  ) {
    const eligible = sources.filter((source) => canBackfill(source, states, run));
    if (eligible.length === 0) break;
    await Promise.all(
      eligible.map(async (source) => {
        const state = states.get(source)!;
        const page = state.pages.length + 1;
        const ctx: RequestCtx = { deadline, logTag: `${requestId} ${source} p${page}` };
        try {
          const last = state.pages[state.pages.length - 1];
          state.pages.push(await searchSourcePage(source, options, last, ctx));
        } catch (error) {
          state.failure = classifyFailure(error);
          state.error = describeSourceError(
            source,
            error instanceof Error ? error.message : String(error),
          );
          warnings.push(`${source} backfill: ${state.error}`);
          // Stop paging this source; keep the pages already in hand.
          state.pages = state.pages.map((page) => ({ ...page, nextCursor: undefined, nextOffset: undefined }));
        } finally {
          state.durationMs = Date.now() - state.startedAt;
        }
      }),
    );
    collection = collect();
  }

  const sourceReports: SourceReport[] = sources.map((source) => {
    const state = states.get(source)!;
    const lastPage = state.pages[state.pages.length - 1];
    const report: SourceReport = {
      source,
      status: (state.failure as SourceReport["status"]) ?? "ok",
      available: lastPage?.available,
      retrieved: state.pages.reduce((sum, page) => sum + page.papers.length, 0),
      pages: state.pages.length,
      queries: state.queries,
      durationMs: state.durationMs,
    };
    if (state.error) {
      report.note = state.error;
    } else if (state.pages.length > 1) {
      report.note = `backfilled to page ${state.pages.length}`;
    } else if (
      collection.screen.selected.length < candidateLimit &&
      report.retrieved === 0
    ) {
      report.note = "no results retrieved";
    } else if (lastPage && lastPage.nextCursor === undefined && lastPage.nextOffset === undefined && lastPage.available !== undefined) {
      report.note = "source exhausted";
    }
    return report;
  });

  warnings.push(...collection.screen.warnings);

  if (deadline.expired()) {
    warnings.push(`deadline exceeded after ${Date.now() - startedAt}ms; partial results returned`);
    logEvent("search.deadline", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      returned: collection.screen.selected.length,
    });
  }
  logEvent("search.end", {
    requestId,
    elapsedMs: Date.now() - startedAt,
    returned: collection.screen.selected.length,
    deduped: collection.deduped.length,
    expired: deadline.expired(),
  });

  if (plan.variants.length === 1 && collection.deduped.length < Math.max(limit * 2, 10)) {
    warnings.push(
      `Narrow retrieval: a single AND query returned ${collection.deduped.length} candidates. Pass "queries" variants (synonyms or alternative vocabulary) — lexical search cannot find papers that never use the topic's words.`,
    );
  }

  const seedReports = input.seedPapers
    ? evaluateSeeds(input.seedPapers, collection.deduped, collection.screen)
    : undefined;

  // Hand back the ranked candidates (up to candidateLimit). The MCP layer
  // ranks by deterministic rules and stops there; topical judgement over the
  // returned abstracts is the calling model's job.
  const results = collection.screen.selected;

  return {
    topic: input.topic,
    criteria,
    totalRawResults: collection.raw.length,
    totalDedupedCandidates: collection.deduped.length,
    returned: results.length,
    results,
    warnings,
    sourceReports,
    rejectedBy: collection.screen.rejectedBy,
    seedReports,
    candidatesBeforeLimit: collection.screen.selectedTotal,
    retrieval: { queries: plan.variants, terms: plan.terms },
    rejectedDetails: input.explain
      ? collection.screen.rejected.map((record) => ({
          title: record.paper.title,
          code: record.code,
          detail: record.detail ?? "",
        }))
      : undefined,
    timing: {
      elapsedMs: Date.now() - startedAt,
      deadlineMs: deadline.totalMs,
      expired: deadline.expired(),
    },
  };
}

/**
 * Make an upstream failure actionable: OpenAlex now requires a free API key to
 * page past the first cursor, and a bare "401 Unauthorized" gives no hint.
 */
function describeSourceError(source: SourceName, message: string): string {
  if (source === "openalex" && /\b401\b/.test(message)) {
    return `${message} (check OPENALEX_API_KEY: OpenAlex now requires a key, including for cursor paging)`;
  }
  return message;
}

function canBackfill(source: SourceName, states: Map<SourceName, SourceState>, run: RunCtx): boolean {
  const state = states.get(source);
  if (!state) return false;
  const last = state.pages[state.pages.length - 1];
  if (!last) return false;
  if (last.nextCursor === undefined && last.nextOffset === undefined) return false;
  if (state.pages.length >= 1 + MAX_BACKFILL_PAGES) return false;
  const pool = state.pages.reduce((sum, page) => sum + page.papers.length, 0);
  if (pool >= POOL_CAPS[source]) return false;
  // Independent per-source budget: a slow source stops paging early and its
  // already-fetched pages stay; the remaining budget must also cover a page
  // plus the response reserve.
  if (Date.now() - state.startedAt >= run.sourceBudgetMs) return false;
  return run.deadline.remainingForWork() > MIN_BACKFILL_BUDGET_MS;
}

async function searchSourcePage(
  source: SourceName,
  options: SearchOptions,
  previous?: ProviderPage,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  if (source === "openalex") {
    return searchOpenAlexPage(options, typeof previous?.nextCursor === "string" ? previous.nextCursor : undefined, ctx);
  }
  if (source === "europepmc") {
    return searchEuropePmcPage(options, typeof previous?.nextCursor === "string" ? previous.nextCursor : undefined, ctx);
  }
  if (source === "arxiv") {
    return searchArxivPage(options, previous?.nextOffset ?? 0, ctx);
  }
  if (source === "pubmed") {
    return searchPubMedPage(options, previous?.nextOffset ?? 0, ctx);
  }
  if (source === "crossref") {
    return searchCrossrefPage(options, previous?.nextOffset ?? 0, ctx);
  }
  return searchSemanticScholarPage(options, previous?.nextOffset ?? 0, ctx);
}

/**
 * Seed calibration: match each requested seed against the deduplicated
 * candidate pool by DOI / arXiv ID / normalized title. "hit" reports the
 * merged record ID and its sources; "filtered" carries the ordered exclusion
 * code; seeds missing from the pool entirely are "not-found" (a
 * retrieval-layer gap).
 */
function evaluateSeeds(
  seeds: string[],
  deduped: Paper[],
  screen: { selected: Paper[]; rejected: Array<{ paper: Paper; code: ExclusionCode }> },
): SeedReport[] {
  return seeds.map((seed) => {
    const matched = matchSeedPaper(deduped, seed);
    if (!matched) {
      return { seed, status: "not-found" as const };
    }
    const rejectedRecord = screen.rejected.find((record) => record.paper.id === matched.id);
    if (rejectedRecord) {
      return {
        seed,
        status: "filtered" as const,
        paperId: matched.id,
        title: matched.title,
        sources: [...matched.sources],
        exclusionCode: rejectedRecord.code,
      };
    }
    // Present in the deduplicated pool (selected, or cut by the limit).
    return {
      seed,
      status: "hit" as const,
      paperId: matched.id,
      title: matched.title,
      sources: [...matched.sources],
    };
  });
}

/**
 * S2 429 degradation chain: resolve the seed paper in OpenAlex (direct DOI
 * lookup, else via a lightweight S2 externalIds lookup), then fetch its
 * related_works as a batch.
 */
async function relatedWorksFromOpenAlex(
  seedId: string,
  limit: number,
  openAlexApiKey?: string,
  semanticScholarApiKey?: string,
  ctx?: RequestCtx,
): Promise<Paper[]> {
  // Accept a bare DOI, a "DOI:"-prefixed DOI, or a doi.org URL without
  // needing Semantic Scholar at all; only fall back to an S2 ID lookup when
  // the seed carries no DOI.
  const doiFromSeed = canonicalDoi(seedId);
  let work = undefined;

  if (doiFromSeed) {
    work = await fetchOpenAlexWorkByDoi(doiFromSeed, openAlexApiKey, ctx);
  } else {
    const external = await getSemanticScholarPaperExternalIds(seedId, semanticScholarApiKey, ctx);
    if (external.doi) work = await fetchOpenAlexWorkByDoi(external.doi, openAlexApiKey, ctx);
  }
  if (!work?.id) return [];

  const related = work.related_works ?? [];
  if (related.length === 0) return [];
  const relatedIds = related.slice(0, Math.max(limit * 2, 30));
  return fetchOpenAlexByIds(relatedIds, openAlexApiKey, ctx);
}
