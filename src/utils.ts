import type { Paper } from "./types.js";

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleKey(title: string): string {
  return normalizeText(title).replace(/\b(the|a|an)\b/g, "").replace(/\s+/g, " ").trim();
}

export function canonicalDoi(doi?: string): string | undefined {
  if (!doi) return undefined;
  const cleaned = doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase();
  // "arXiv:..." identifiers are not DOIs; treat them as absent so they never
  // become bogus DOI keys.
  if (!cleaned || cleaned.startsWith("arxiv:")) return undefined;
  return cleaned;
}

export function canonicalArxivId(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "").replace(/\.pdf$/i, "");
  const match = cleaned.match(/(?:arxiv:)?([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  return match?.[1]?.toLowerCase();
}

export function compact<T>(values: Array<T | undefined | null>): T[] {
  return values.filter((value): value is T => value !== undefined && value !== null);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Clean a raw topic so it can be safely embedded into provider query
 * strings: drop quotes, colons, commas (the OpenAlex filter separator),
 * brackets (which also removes unpaired parentheses), and backslashes,
 * then collapse whitespace. Deterministic string surgery only.
 */
export function sanitizeTopic(topic: string): string {
  return topic
    .replace(/["'`:;,[\]()\\{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Academic stopwords plus short function words. Shared by screening, query
 * planning, and provider query builders so "what counts as a searchable term"
 * is defined in exactly one place.
 */
const SEARCH_STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "of", "for", "to", "in", "on", "with", "by",
  "from", "using", "based", "not", "into", "via", "versus", "vs", "non",
]);

/**
 * Content tokens of a topic/query variant. Lowercased, punctuation-normalised,
 * stopwords and <=2-character tokens removed, capped so a long sentence does
 * not turn into an unbounded AND chain at the provider.
 */
export function searchTerms(text: string, maxTokens = 8): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((term) => term.length > 2 && !SEARCH_STOPWORDS.has(term))
    .slice(0, maxTokens);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Coerce one provider record into a clean Paper.
 *
 * Provider JSON is typed as optional, but real payloads carry `null` for an
 * absent value (OpenAlex `oa_url: null`, Semantic Scholar `abstract: null`).
 * Letting those through makes `structuredContent` emit `null`, and a strict
 * MCP input schema then rejects the record when a caller feeds `results`
 * back into another tool (generate_research_ideas, review_research_idea,
 * export_to_zotero). Drop nulls and repair collection fields at the boundary.
 */
export function normalizePaper(input: Paper): Paper {
  const paper = stripNulls({ ...input });
  paper.authors = Array.isArray(paper.authors)
    ? paper.authors.filter((author): author is string => typeof author === "string")
    : [];
  paper.sources = Array.isArray(paper.sources) ? paper.sources : [];
  paper.sourceIds =
    paper.sourceIds && typeof paper.sourceIds === "object" ? paper.sourceIds : {};
  return paper;
}

function stripNulls(paper: Paper): Paper {
  const record = paper as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return paper;
}

/**
 * Multi-key deduplication: a paper is registered under every key it carries
 * (DOI, arXiv ID, OpenAlex ID, title, title+year), so an arXiv-only record
 * with the same title as a DOI-bearing OpenAlex record still merges even
 * though they share no identifier key.
 *
 * Merge preferences: the formally published record (one that has a DOI or a
 * real venue) wins for url/venue/year; citation counts take the max of
 * defined values; the longest abstract is kept.
 */
export function mergePapers(papers: Paper[]): Paper[] {
  const byKey = new Map<string, Paper>();
  const ordered: Paper[] = [];

  const keysFor = (paper: Paper): string[] => {
    const doi = canonicalDoi(paper.doi);
    const arxivId = canonicalArxivId(paper.arxivId);
    const keys: string[] = [];
    if (doi) keys.push(`doi:${doi}`);
    if (arxivId) keys.push(`arxiv:${arxivId}`);
    if (paper.openalexId) keys.push(`openalex:${paper.openalexId}`);
    const title = titleKey(paper.title);
    if (title) {
      keys.push(`title:${title}`);
      if (paper.year) keys.push(`title-year:${title}|${paper.year}`);
    }
    return keys;
  };

  const register = (paper: Paper): void => {
    for (const key of keysFor(paper)) byKey.set(key, paper);
  };

  for (const rawPaper of papers) {
    const paper = normalizePaper(rawPaper);
    const doi = canonicalDoi(paper.doi);
    const arxivId = canonicalArxivId(paper.arxivId);
    const keys = keysFor(paper);
    const existingKey = keys.find((key) => byKey.has(key));
    const existing = existingKey ? byKey.get(existingKey) : undefined;

    if (!existing) {
      const record: Paper = {
        ...paper,
        doi,
        arxivId,
        authors: unique(paper.authors),
        sources: unique(paper.sources),
      };
      ordered.push(record);
      register(record);
      continue;
    }

    existing.authors = unique([...existing.authors, ...paper.authors]);
    existing.sources = unique([...existing.sources, ...paper.sources]);
    existing.sourceIds = { ...existing.sourceIds, ...paper.sourceIds };
    existing.doi = existing.doi ?? doi;
    existing.arxivId = existing.arxivId ?? arxivId;
    existing.openalexId = existing.openalexId ?? paper.openalexId;
    existing.semanticScholarId = existing.semanticScholarId ?? paper.semanticScholarId;
    existing.pmid = existing.pmid ?? paper.pmid;

    // Prefer the formally published record for venue/url/year: a real
    // journal venue (or a DOI-bearing record) beats "arXiv" placeholders.
    if (isMorePublished(paper, existing)) {
      existing.venue = paper.venue ?? existing.venue;
      existing.url = paper.url ?? existing.url;
      existing.publishedDate = paper.publishedDate ?? existing.publishedDate;
      if (paper.year) existing.year = paper.year;
    } else {
      existing.year = existing.year ?? paper.year;
      existing.publishedDate = existing.publishedDate ?? paper.publishedDate;
      existing.venue = existing.venue ?? paper.venue;
      existing.url = existing.url ?? paper.url;
    }

    existing.abstract = longest(existing.abstract, paper.abstract);
    existing.oaUrl = existing.oaUrl ?? paper.oaUrl;
    existing.openAccess = existing.openAccess ?? paper.openAccess;
    existing.citationCount = maxDefined(existing.citationCount, paper.citationCount);
    existing.influentialCitationCount = maxDefined(
      existing.influentialCitationCount,
      paper.influentialCitationCount,
    );

    // Re-register under the enriched key set so later duplicates find it.
    register(existing);
  }

  // Merging can assign an `undefined` from a peer record; normalise once more so
  // every returned record has the same clean shape.
  return ordered.map(normalizePaper);
}

/**
 * True when `candidate` looks like the formally published record relative to
 * `incumbent`: it carries a DOI the incumbent lacks, or a real (non-preprint)
 * venue the incumbent lacks.
 */
function isMorePublished(candidate: Paper, incumbent: Paper): boolean {
  const venue = candidate.venue?.trim();
  const hasRealVenue = Boolean(venue) && venue!.toLowerCase() !== "arxiv";
  const incumbentVenue = incumbent.venue?.trim();
  const incumbentHasRealVenue = Boolean(incumbentVenue) && incumbentVenue!.toLowerCase() !== "arxiv";
  if (candidate.doi && !incumbent.doi) return true;
  return hasRealVenue && !incumbentHasRealVenue;
}

/**
 * Returns the larger of two counts, preserving a real 0 instead of collapsing
 * it to undefined. Only returns undefined when both inputs are undefined.
 */
function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function longest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

export function reconstructOpenAlexAbstract(index?: Record<string, number[]>): string | undefined {
  if (!index) return undefined;
  const words: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([word, position]);
  }
  return words
    .sort((a, b) => a[1] - b[1])
    .map(([word]) => word)
    .join(" ");
}

/**
 * Match a user-supplied seed paper (a DOI, an arXiv ID, or a full title)
 * against a deduplicated candidate pool. Deterministic key comparison only:
 * DOI equality, arXiv ID equality, then normalized-title equality.
 */
export function matchSeedPaper(papers: Paper[], seed: string): Paper | undefined {
  const trimmed = seed.trim();
  if (!trimmed) return undefined;

  const doi = canonicalDoi(trimmed);
  if (doi) {
    const byDoi = papers.find((paper) => canonicalDoi(paper.doi) === doi);
    if (byDoi) return byDoi;
  }

  const arxivId = canonicalArxivId(trimmed);
  if (arxivId) {
    const byArxiv = papers.find((paper) => canonicalArxivId(paper.arxivId) === arxivId);
    if (byArxiv) return byArxiv;
    // Records indexed by OpenAlex carry arXiv papers under the arXiv DOI.
    const arxivDoi = `10.48550/arxiv.${arxivId}`;
    const byArxivDoi = papers.find((paper) => canonicalDoi(paper.doi) === arxivDoi);
    if (byArxivDoi) return byArxivDoi;
  }

  const title = titleKey(trimmed);
  if (title) {
    return papers.find((paper) => titleKey(paper.title) === title);
  }
  return undefined;
}
