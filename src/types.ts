export type SourceName = "openalex" | "europepmc" | "semantic_scholar" | "arxiv" | "pubmed" | "crossref";

export type ExclusionCode =
  | "year"
  | "min-citations"
  | "excluded-term"
  | "missing-must"
  | "preprint"
  | "below-relevance";

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  publishedDate?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  openalexId?: string;
  semanticScholarId?: string;
  pmid?: string;
  url?: string;
  oaUrl?: string;
  openAccess?: boolean;
  abstract?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  sources: SourceName[];
  sourceIds: Partial<Record<SourceName, string>>;
  /**
   * True when the record is a preprint (arXiv record, Europe PMC PPR, Crossref
   * posted-content, OpenAlex type=preprint). Merging with a formally published
   * record clears it.
   */
  isPreprint?: boolean;
  score?: number;
  /** Per-factor contribution to `score`, so a ranking position is auditable. */
  scoreBreakdown?: ScoreBreakdown;
  reasons?: string[];
}

/**
 * How a paper's score was assembled. Each entry is the exact number added by
 * that factor, and the total is their sum (rounded to 2 decimals like `score`).
 */
export interface ScoreBreakdown {
  topicTerms: number;
  mustPhrases: number;
  preferPhrases: number;
  crossSource: number;
  /** DOI/arXiv ID presence, title match, abstract present. */
  metadata: number;
  citations: number;
  influentialCitations: number;
  recency: number;
}

export interface ScreeningCriteria {
  mustInclude?: string[];
  prefer?: string[];
  exclude?: string[];
  minCitations?: number;
  yearFrom?: number;
  yearTo?: number;
  includePreprints?: boolean;
  /**
   * Default true: without mustInclude terms, papers must match at least one
   * topic term (below-relevance otherwise). Set false for flows without a
   * meaningful topic string (e.g. expand_related without an explicit topic).
   */
  requireTopicMatch?: boolean;
}

export interface SearchOptions {
  topic: string;
  yearFrom?: number;
  yearTo?: number;
  limit: number;
  sources: SourceName[];
  includePreprints: boolean;
  /**
   * Pushed down to OpenAlex as `cited_by_count:>N-1` so filtering happens
   * server-side before relevance truncation. Sources without citation counts
   * (arXiv) ignore it.
   */
  minCitations?: number;
  /**
   * Pushed down to OpenAlex as `is_retracted:false` unless true. Retractions
   * are excluded by default; `includeRetracted: true` retrieves them again.
   */
  includeRetracted?: boolean;
  /**
   * All query variants (primary topic first). Providers AND the words inside a
   * variant and OR the variants, so different phrasings of one concept all
   * retrieve instead of requiring one exact vocabulary.
   */
  variants?: string[];
  semanticScholarApiKey?: string;
}

/** One page of results from a provider, plus pagination tokens for backfill. */
export interface ProviderPage {
  papers: Paper[];
  /** Server-reported total matching the query (opensearch:totalResults / meta.count / hitCount / S2 total). */
  available?: number;
  /** Opaque cursor (OpenAlex / Europe PMC) for the next page. */
  nextCursor?: string;
  /** Numeric offset (arXiv start / Semantic Scholar offset) for the next page. */
  nextOffset?: number;
}

/** One rejected candidate with a human-readable explanation. */
export interface RejectionDetail {
  title: string;
  code: ExclusionCode;
  /** Why it was rejected, e.g. "published 1998 outside 2005-2024". */
  detail: string;
}

/** Why a source produced what it produced. */
export type SourceStatus = "ok" | "timeout" | "rate_limited" | "upstream_error" | "cancelled";

export interface SourceReport {
  source: SourceName;
  /** ok = query succeeded (retrieved may still be 0); others = failure class. */
  status: SourceStatus;
  available?: number;
  retrieved: number;
  pages: number;
  /** Query variants this source actually ran (S2 accepts only the primary). */
  queries: string[];
  durationMs?: number;
  note?: string;
}

export type SeedStatus = "hit" | "filtered" | "not-found";

export interface SeedReport {
  seed: string;
  status: SeedStatus;
  paperId?: string;
  title?: string;
  sources?: SourceName[];
  exclusionCode?: ExclusionCode;
}

export interface ScreenedResult {
  topic: string;
  criteria: ScreeningCriteria;
  totalRawResults: number;
  totalDedupedCandidates: number;
  returned: number;
  results: Paper[];
  warnings: string[];
  sourceReports?: SourceReport[];
  rejectedBy?: Partial<Record<ExclusionCode, number>>;
  seedReports?: SeedReport[];
  /**
   * When candidateLimit widened the pool, this is how many screened
   * candidates were available before the caller-facing limit was applied.
   */
  candidatesBeforeLimit?: number;
  /**
   * What retrieval actually ran, so a thin result set can be traced to a narrow
   * query rather than assumed to reflect the corpus.
   */
  retrieval?: {
    queries: string[];
    terms: string[];
  };
  /** Present when `explain` was requested: why each rejected candidate failed. */
  rejectedDetails?: RejectionDetail[];
  /** Wall-clock accounting of this call, so partial results are explicable. */
  timing?: {
    elapsedMs: number;
    deadlineMs: number;
    expired: boolean;
  };
}
