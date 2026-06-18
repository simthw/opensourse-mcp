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
  return doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase();
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

export function mergePapers(papers: Paper[]): Paper[] {
  const merged = new Map<string, Paper>();

  for (const paper of papers) {
    const doi = canonicalDoi(paper.doi);
    const arxivId = canonicalArxivId(paper.arxivId);
    const key = doi ? `doi:${doi}` : arxivId ? `arxiv:${arxivId}` : `title:${titleKey(paper.title)}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...paper,
        doi,
        arxivId,
        authors: unique(paper.authors),
        sources: unique(paper.sources),
      });
      continue;
    }

    existing.authors = unique([...existing.authors, ...paper.authors]);
    existing.sources = unique([...existing.sources, ...paper.sources]);
    existing.sourceIds = { ...existing.sourceIds, ...paper.sourceIds };
    existing.year = existing.year ?? paper.year;
    existing.publishedDate = existing.publishedDate ?? paper.publishedDate;
    existing.venue = existing.venue ?? paper.venue;
    existing.doi = existing.doi ?? doi;
    existing.arxivId = existing.arxivId ?? arxivId;
    existing.openalexId = existing.openalexId ?? paper.openalexId;
    existing.semanticScholarId = existing.semanticScholarId ?? paper.semanticScholarId;
    existing.url = existing.url ?? paper.url;
    existing.abstract = longest(existing.abstract, paper.abstract);
    existing.citationCount = maxDefined(existing.citationCount, paper.citationCount);
    existing.influentialCitationCount = maxDefined(
      existing.influentialCitationCount,
      paper.influentialCitationCount,
    );
  }

  return [...merged.values()];
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
