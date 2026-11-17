import type { ExclusionCode, Paper, ScoreBreakdown, ScreeningCriteria } from "./types.js";
import { normalizeText, escapeRegExp, searchTerms } from "./utils.js";

const DEFAULT_EXCLUDE = ["editorial", "commentary", "erratum", "correction", "letter to the editor"];

export interface RejectedRecord {
  paper: Paper;
  code: ExclusionCode;
  /** Human-readable explanation ("published 1998 outside 2005-2024"). */
  detail?: string;
}

export interface ScreenOutcome {
  selected: Paper[];
  /** Candidates that passed screening before the caller-facing limit was applied. */
  selectedTotal: number;
  rejected: RejectedRecord[];
  rejectedBy: Partial<Record<ExclusionCode, number>>;
  warnings: string[];
}

/**
 * Backward-compatible entry point: returns only the selected papers, in
 * ranked order. Use screenAndRankDetailed for exclusion codes and warnings.
 */
export function screenAndRank(
  topic: string,
  papers: Paper[],
  criteria: ScreeningCriteria,
  limit: number,
  options: ScreenOptions = {},
): Paper[] {
  return screenAndRankDetailed(topic, papers, criteria, limit, options).selected;
}

export interface ScreenOptions {
  /**
   * Screening vocabulary. A multi-variant search accepts a paper that matches
   * ANY variant's terms, so the caller passes the union here; without it the
   * terms are derived from `topic` alone (single-query behaviour).
   */
  terms?: string[];
  /**
   * Text used to decide whether a default exclusion term is the subject of the
   * query. For multi-variant searches this should include every variant, not
   * just the primary topic.
   */
  excludeContext?: string;
}

/**
 * Screen and rank with full transparency:
 * - token-boundary term matching (a "graph" hit never matches "paragraph"),
 * - ordered exclusion codes (first matching rule wins),
 * - a minimum relevance floor when no mustInclude terms are given: at least
 *   one topic term must be matched, otherwise the paper is rejected as
 *   below-relevance and the shortfall is reported in warnings.
 */
export function screenAndRankDetailed(
  topic: string,
  papers: Paper[],
  criteria: ScreeningCriteria,
  limit: number,
  options: ScreenOptions = {},
): ScreenOutcome {
  const topicTerms = options.terms?.length ? options.terms : terms(topic);
  const topicText = normalizeText(options.excludeContext ?? topic);
  const must = (criteria.mustInclude ?? []).map(normalizeText).filter(Boolean);
  const prefer = (criteria.prefer ?? []).map(normalizeText).filter(Boolean);
  // The default exclude list is a publication-type noise filter, but a topic
  // can use one of those words as its subject ("quantum error correction",
  // "editorial policy"). Applying the filter there would reject every
  // on-topic paper, so a default term is only active when the topic itself
  // does not contain it. Caller-supplied excludes always apply: that is an
  // explicit instruction, not a heuristic.
  const defaults = DEFAULT_EXCLUDE.filter((term) => !containsTerm(topicText, normalizeText(term)));
  const exclude = [...defaults, ...(criteria.exclude ?? [])].map(normalizeText).filter(Boolean);

  const rejected: RejectedRecord[] = [];
  const selected: Paper[] = [];

  for (const paper of papers) {
    const outcome = scorePaper(paper, topicTerms, must, prefer, exclude, criteria);
    if (outcome.selected && outcome.code === undefined) {
      selected.push(outcome.paper);
    } else if (!outcome.selected && outcome.code !== undefined) {
      rejected.push({ paper: outcome.paper, code: outcome.code, detail: outcome.detail });
    }
  }

  // Neutral, explainable ordering (see compareCandidates). The MCP layer does
  // not pretend to measure topical relevance: it orders candidates by how much
  // of the topic appears in the abstract, then by recency, then by citations,
  // so a strong new paper is not buried under an old highly cited one.
  selected.sort(compareCandidates(topicTerms));

  const selectedTotal = selected.length;
  const selectedPapers = selected.slice(0, Math.max(limit, 1));
  const rejectedBy: Partial<Record<ExclusionCode, number>> = {};
  for (const record of rejected) {
    rejectedBy[record.code] = (rejectedBy[record.code] ?? 0) + 1;
  }

  const warnings: string[] = [];
  if (selectedPapers.length < Math.max(limit, 1)) {
    const summary = Object.entries(rejectedBy)
      .map(([code, count]) => `${code}: ${count}`)
      .join(", ");
    if (summary.length > 0) {
      warnings.push(
        `Screening returned ${selectedPapers.length} of ${requestedOr(limit)} requested; rejected candidates: ${summary}`,
      );
    }
  }

  return { selected: selectedPapers, selectedTotal, rejected, rejectedBy, warnings };
}

function requestedOr(limit: number): number {
  return Math.max(limit, 1);
}

/**
 * Neutral, explainable ordering used for the caller-facing candidate list.
 *
 * Deliberately not a relevance model: the calling agent judges topical fit
 * from the returned abstracts. The MCP layer only guarantees a stable,
 * inspectable order:
 *
 *   1. topic terms found in the ABSTRACT, descending — abstract content is the
 *      most reliable signal of what the paper actually does;
 *   2. publication year, descending — a new paper with few citations is not
 *      buried under a decade-old paper with thousands (citation counts take
 *      years to accumulate, so recency is applied before citations);
 *   3. citation count, descending — ties broken by established impact;
 *   4. title, ascending — stable, deterministic final tiebreak.
 */
function compareCandidates(topicTerms: string[]) {
  const abstractHits = (paper: Paper): number => {
    const abstract = normalizeText(paper.abstract ?? "");
    if (!abstract) return 0;
    return topicTerms.filter((term) => containsTerm(abstract, term)).length;
  };

  return (a: Paper, b: Paper): number => {
    const byHits = abstractHits(b) - abstractHits(a);
    if (byHits !== 0) return byHits;

    const byYear = (b.year ?? 0) - (a.year ?? 0);
    if (byYear !== 0) return byYear;

    const byCitations = (b.citationCount ?? 0) - (a.citationCount ?? 0);
    if (byCitations !== 0) return byCitations;

    return a.title.localeCompare(b.title);
  };
}

interface ScoreOutcome {
  selected: boolean;
  paper: Paper;
  code?: ExclusionCode;
  detail?: string;
}

function scorePaper(
  paper: Paper,
  topicTerms: string[],
  must: string[],
  prefer: string[],
  exclude: string[],
  criteria: ScreeningCriteria,
): ScoreOutcome {
  const text = normalizeText(
    [paper.title, paper.abstract, paper.venue, paper.authors.join(" ")].filter(Boolean).join(" "),
  );
  const title = normalizeText(paper.title);
  const reasons: string[] = [];

  const fail = (code: ExclusionCode, detail: string): ScoreOutcome => ({
    selected: false,
    paper: { ...paper, score: Number.NEGATIVE_INFINITY, reasons: [] },
    code,
    detail,
  });

  if (criteria.yearFrom && paper.year && paper.year < criteria.yearFrom) {
    return fail("year", "published " + paper.year + " before the requested " + criteria.yearFrom);
  }
  if (criteria.yearTo && paper.year && paper.year > criteria.yearTo) {
    return fail("year", "published " + paper.year + " after the requested " + criteria.yearTo);
  }
  if (
    criteria.minCitations !== undefined &&
    paper.citationCount !== undefined &&
    paper.citationCount < criteria.minCitations
  ) {
    return fail("min-citations", paper.citationCount + " citations < " + criteria.minCitations + " requested");
  }
  const matchedExclude = exclude.find((term) => containsTerm(text, term));
  if (matchedExclude) {
    return fail("excluded-term", "matched excluded term " + JSON.stringify(matchedExclude));
  }
  if (must.length > 0) {
    const missing = must.filter((term) => !containsTerm(text, term));
    if (missing.length > 0) return fail("missing-must", "missing required term(s): " + missing.join(", "));
  }
  if (criteria.includePreprints === false && paper.sources.length === 1 && paper.sources.includes("arxiv")) {
    return fail("preprint", "arXiv-only record and preprints are excluded");
  }

  // Minimum relevance floor: without mustInclude terms, require at least one
  // topic-term hit so completely unrelated records do not pass silently.
  // Deliberately permissive: judging topical fit from a term-count ratio
  // misfires for asymmetric topics such as "thermodynamics community ecology",
  // where the domain words (community, ecology) are shared by every paper in
  // the field and an on-topic paper may name the topic only once. The calling
  // model does the real relevance judgement over the returned abstracts.
  if (
    must.length === 0 &&
    topicTerms.length > 0 &&
    criteria.requireTopicMatch !== false
  ) {
    const matchedTopicTerms = topicTerms.filter((term) => containsTerm(text, term));
    if (matchedTopicTerms.length === 0) {
      return fail(
        "below-relevance",
        "no hit for any screening term (" + topicTerms.slice(0, 8).join(", ") + (topicTerms.length > 8 ? ", …" : "") + ")",
      );
    }
  }

  // Every factor is tracked separately so the ranking position is auditable:
  // score is exactly the sum of the reported breakdown entries.
  const breakdown: ScoreBreakdown = {
    topicTerms: 0,
    mustPhrases: 0,
    preferPhrases: 0,
    crossSource: 0,
    metadata: 0,
    citations: 0,
    influentialCitations: 0,
    recency: 0,
  };

  const matchedTopicTerms = topicTerms.filter((term) => containsTerm(text, term));
  breakdown.topicTerms = matchedTopicTerms.length * 3;
  if (matchedTopicTerms.length > 0) reasons.push(`matches ${matchedTopicTerms.slice(0, 5).join(", ")}`);

  for (const phrase of prefer) {
    if (containsTerm(text, phrase)) {
      breakdown.preferPhrases += 8;
      reasons.push(`preferred phrase: ${phrase}`);
    }
  }

  for (const phrase of must) {
    if (containsTerm(text, phrase)) {
      breakdown.mustPhrases += 12;
      reasons.push(`required phrase: ${phrase}`);
    }
  }

  if (paper.sources.length > 1) {
    breakdown.crossSource = 10 + paper.sources.length * 2;
    reasons.push(`confirmed by ${paper.sources.join(", ")}`);
  }

  if (paper.doi) breakdown.metadata += 4;
  if (paper.arxivId) breakdown.metadata += 2;
    if (title.length > 0 && topicTerms.some((term) => containsTerm(title, term))) breakdown.metadata += 8;
  if (paper.abstract) breakdown.metadata += 3;

  // Unknown citation counts (arXiv has none) pass with an explicit note
  // instead of being silently scored as zero.
  if (paper.citationCount === undefined) {
    if (criteria.minCitations !== undefined && criteria.minCitations > 0) {
      reasons.push("citation count unknown; passed minCitations filter");
    }
  } else if (paper.citationCount > 0) {
    const citations = paper.citationCount;
    breakdown.citations = Math.min(20, Math.log10(citations + 1) * 8);
    reasons.push(`${citations} citations`);
  }

  if (paper.influentialCitationCount) {
    breakdown.influentialCitations = Math.min(10, Math.log10(paper.influentialCitationCount + 1) * 6);
  }

  if (paper.year) {
    const age = Math.max(0, new Date().getUTCFullYear() - paper.year);
    breakdown.recency = Math.max(0, 8 - age);
    if (age <= 2) reasons.push(`recent (${paper.year})`);
  }

  // Round each factor first, then total them: the printed breakdown always
  // adds up to the reported score.
  const rounded: ScoreBreakdown = Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => [key, round2(value)]),
  ) as unknown as ScoreBreakdown;
  const score = round2(
    rounded.topicTerms +
      rounded.mustPhrases +
      rounded.preferPhrases +
      rounded.crossSource +
      rounded.metadata +
      rounded.citations +
      rounded.influentialCitations +
      rounded.recency,
  );

  return {
    selected: true,
    paper: {
      ...paper,
      score,
      scoreBreakdown: rounded,
      reasons: reasons.length > 0 ? uniqueReasons(reasons) : ["selected by relevance and metadata quality"],
    },
  };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Token-boundary term matching on normalized text: the term must appear as a
 * whole token sequence, never as a substring inside a longer word
 * ("economics" does not match "omics", "paragraph" does not match "graph").
 * Multi-word terms match when the words appear adjacently.
 */
function containsTerm(text: string, term: string): boolean {
  const words = term.split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const pattern = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}

function terms(topic: string): string[] {
  return searchTerms(topic);
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 6);
}
