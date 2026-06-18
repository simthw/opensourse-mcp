import type { Paper, ScreeningCriteria } from "./types.js";
import { normalizeText } from "./utils.js";

const DEFAULT_EXCLUDE = ["editorial", "commentary", "erratum", "correction", "letter to the editor"];

export function screenAndRank(
  topic: string,
  papers: Paper[],
  criteria: ScreeningCriteria,
  limit: number,
): Paper[] {
  const topicTerms = terms(topic);
  const must = (criteria.mustInclude ?? []).map(normalizeText).filter(Boolean);
  const prefer = (criteria.prefer ?? []).map(normalizeText).filter(Boolean);
  const exclude = [...DEFAULT_EXCLUDE, ...(criteria.exclude ?? [])].map(normalizeText).filter(Boolean);

  return papers
    .map((paper) => scorePaper(paper, topicTerms, must, prefer, exclude, criteria))
    .filter((paper) => paper.score !== undefined && paper.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.max(limit, 1));
}

function scorePaper(
  paper: Paper,
  topicTerms: string[],
  must: string[],
  prefer: string[],
  exclude: string[],
  criteria: ScreeningCriteria,
): Paper {
  const text = normalizeText([paper.title, paper.abstract, paper.venue, paper.authors.join(" ")].filter(Boolean).join(" "));
  const title = normalizeText(paper.title);
  const reasons: string[] = [];

  if (criteria.yearFrom && paper.year && paper.year < criteria.yearFrom) return rejected(paper);
  if (criteria.yearTo && paper.year && paper.year > criteria.yearTo) return rejected(paper);
  if (criteria.minCitations && (paper.citationCount ?? 0) < criteria.minCitations) return rejected(paper);
  if (criteria.includePreprints === false && paper.sources.length === 1 && paper.sources.includes("arxiv")) return rejected(paper);
  if (exclude.some((term) => containsPhrase(text, term))) return rejected(paper);
  if (must.length > 0 && !must.every((term) => containsPhrase(text, term))) return rejected(paper);

  let score = 0;
  const matchedTopicTerms = topicTerms.filter((term) => text.includes(term));
  score += matchedTopicTerms.length * 3;
  if (matchedTopicTerms.length > 0) reasons.push(`matches ${matchedTopicTerms.slice(0, 5).join(", ")}`);

  for (const phrase of prefer) {
    if (containsPhrase(text, phrase)) {
      score += 8;
      reasons.push(`preferred phrase: ${phrase}`);
    }
  }

  for (const phrase of must) {
    if (containsPhrase(text, phrase)) {
      score += 12;
      reasons.push(`required phrase: ${phrase}`);
    }
  }

  if (paper.sources.length > 1) {
    score += 10 + paper.sources.length * 2;
    reasons.push(`confirmed by ${paper.sources.join(", ")}`);
  }

  if (paper.doi) score += 4;
  if (paper.arxivId) score += 2;
  if (title.length > 0 && topicTerms.some((term) => title.includes(term))) score += 8;
  if (paper.abstract) score += 3;

  const citations = paper.citationCount ?? 0;
  if (citations > 0) {
    score += Math.min(20, Math.log10(citations + 1) * 8);
    reasons.push(`${citations} citations`);
  }

  if (paper.influentialCitationCount) {
    score += Math.min(10, Math.log10(paper.influentialCitationCount + 1) * 6);
  }

  if (paper.year) {
    const age = Math.max(0, new Date().getUTCFullYear() - paper.year);
    score += Math.max(0, 8 - age);
    if (age <= 2) reasons.push(`recent (${paper.year})`);
  }

  return {
    ...paper,
    score: Number(score.toFixed(2)),
    reasons: reasons.length > 0 ? uniqueReasons(reasons) : ["selected by relevance and metadata quality"],
  };
}

function rejected(paper: Paper): Paper {
  return { ...paper, score: Number.NEGATIVE_INFINITY, reasons: [] };
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && text.includes(phrase);
}

function terms(topic: string): string[] {
  const stop = new Set([
    "and",
    "or",
    "the",
    "a",
    "an",
    "of",
    "for",
    "to",
    "in",
    "on",
    "with",
    "by",
    "from",
    "using",
    "based",
  ]);
  return normalizeText(topic)
    .split(" ")
    .filter((term) => term.length > 2 && !stop.has(term));
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 6);
}
