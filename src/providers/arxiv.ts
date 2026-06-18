import { XMLParser } from "fast-xml-parser";
import type { Paper, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { canonicalArxivId, compact } from "../utils.js";

interface ArxivFeed {
  feed?: {
    entry?: ArxivEntry | ArxivEntry[];
  };
}

interface ArxivEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: ArxivAuthor | ArxivAuthor[];
  category?: Array<{ "@_term"?: string }> | { "@_term"?: string };
  "arxiv:doi"?: string;
  link?: Array<{ "@_href"?: string; "@_title"?: string }> | { "@_href"?: string; "@_title"?: string };
}

interface ArxivAuthor {
  name?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
});

export async function searchArxiv(options: SearchOptions): Promise<Paper[]> {
  const params = new URLSearchParams({
    search_query: buildQuery(options),
    start: "0",
    max_results: String(Math.min(Math.max(options.limit, 1), 100)),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const response = await fetchWithTimeout(`https://export.arxiv.org/api/query?${params}`);
  if (!response.ok) {
    throw new Error(`arXiv request failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const data = parser.parse(xml) as ArxivFeed;
  const entries = Array.isArray(data.feed?.entry) ? data.feed.entry : compact([data.feed?.entry]);

  return entries.map(toPaper).filter((paper) => {
    if (!paper.title) return false;
    // Keep a client-side guard in case the date range filter is approximate.
    if (options.yearFrom && paper.year && paper.year < options.yearFrom) return false;
    if (options.yearTo && paper.year && paper.year > options.yearTo) return false;
    return true;
  });
}

/**
 * Push the year range into the arXiv query via submittedDate so the date
 * window is applied before relevance truncation, instead of discarding
 * already-fetched results client-side.
 */
export function buildQuery(options: SearchOptions): string {
  const base = `all:${options.topic}`;
  if (!options.yearFrom && !options.yearTo) return base;

  const from = `${options.yearFrom ?? 1900}0101000000`;
  const to = `${options.yearTo ?? new Date().getUTCFullYear()}1231235959`;
  return `(${base}) AND submittedDate:[${from} TO ${to}]`;
}

function toPaper(entry: ArxivEntry): Paper {
  const authors = Array.isArray(entry.author) ? entry.author : compact([entry.author]);
  const links = Array.isArray(entry.link) ? entry.link : compact([entry.link]);
  const pdf = links.find((link) => link["@_title"] === "pdf")?.["@_href"];
  const publishedYear = entry.published ? Number(entry.published.slice(0, 4)) : undefined;
  const arxivId = canonicalArxivId(entry.id);

  return {
    id: entry.id ?? arxivId ?? entry.title ?? "",
    title: clean(entry.title),
    authors: compact(authors.map((author) => author.name)),
    year: Number.isFinite(publishedYear) ? publishedYear : undefined,
    publishedDate: entry.published,
    venue: "arXiv",
    doi: entry["arxiv:doi"],
    arxivId,
    url: entry.id ?? pdf,
    abstract: clean(entry.summary),
    citationCount: 0,
    sources: ["arxiv"],
    sourceIds: { arxiv: arxivId ?? entry.id ?? "" },
  };
}

function clean(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
