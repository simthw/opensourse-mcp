import { XMLParser } from "fast-xml-parser";
import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { canonicalArxivId, compact } from "../utils.js";
import { variantGroups } from "../queryPlan.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";

interface ArxivFeed {
  feed?: {
    title?: string;
    "opensearch:totalResults"?: string | number | { "#text"?: string | number };
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

const MAX_PAGE = 100;
/** arXiv asks for at most 1 request per 3 seconds; honor it on retries. */
const ARXIV_MIN_RETRY_DELAY_MS = 3000;

export async function searchArxivPage(
  options: SearchOptions,
  start = 0,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const params = new URLSearchParams({
    search_query: buildQuery(options),
    start: String(Math.max(start, 0)),
    max_results: String(Math.min(Math.max(options.limit, 1), MAX_PAGE)),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const response = await fetchWithTimeout(`https://export.arxiv.org/api/query?${params}`, {
    minRetryDelayMs: ARXIV_MIN_RETRY_DELAY_MS,
    // arXiv asks for at most 1 request / 3 seconds; pace concurrent callers.
    throttleMs: ARXIV_MIN_RETRY_DELAY_MS,
    // The arXiv API is regularly slow to answer; give it more headroom than
    // the 15s default so a slow-but-healthy response is not dropped. The
    // call budget still wins when it is smaller.
    ...ctxOptions(ctx, { timeoutMs: 30000 }),
  });
  if (!response.ok) {
    throw new Error(`arXiv request failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const data = parser.parse(xml) as ArxivFeed;
  const available = parseTotalResults(data.feed?.["opensearch:totalResults"]);
  const entries = Array.isArray(data.feed?.entry) ? data.feed.entry : compact([data.feed?.entry]);

  const papers: Paper[] = [];
  for (const entry of entries) {
    // arXiv answers invalid queries with HTTP 200 plus a synthetic
    // <entry><title>Error</title>... record. Surface it as an error —
    // it must never be emitted as a paper.
    if ((entry.title ?? "").trim().toLowerCase() === "error") {
      throw new Error(`arXiv query error: ${clean(entry.summary) || "invalid search query"}`);
    }
    const paper = toPaper(entry);
    if (!paper.title) continue;
    // Keep a client-side guard in case the date range filter is approximate.
    if (options.yearFrom && paper.year && paper.year < options.yearFrom) continue;
    if (options.yearTo && paper.year && paper.year > options.yearTo) continue;
    papers.push(paper);
  }

  const nextOffset =
    papers.length > 0 && available !== undefined && start + papers.length < available
      ? start + papers.length
      : undefined;

  return { papers, available, nextOffset };
}

/**
 * Build an arXiv query as an AND over the first 8 sanitized topic tokens
 * (no phrase-ization), pushing the year range into submittedDate so the
 * date window is applied before relevance truncation.
 */
export function buildQuery(options: SearchOptions): string {
  const groups = variantGroups(options.topic, options.variants).map((tokens) =>
    tokens.map((token) => `all:${token}`).join(" AND "),
  );
  if (groups.length === 0) {
    throw new Error(`Topic produced no searchable tokens: "${options.topic}"`);
  }
  // Several phrasings of the concept are ORed; the words inside each phrasing
  // stay ANDed (arXiv has no relevance ranking worth relying on).
  const base =
    groups.length === 1 ? groups[0] : groups.map((group) => `(${group})`).join(" OR ");
  if (!options.yearFrom && !options.yearTo) return base;

  const from = `${options.yearFrom ?? 1900}0101000000`;
  const to = `${options.yearTo ?? new Date().getUTCFullYear()}1231235959`;
  return `(${base}) AND submittedDate:[${from} TO ${to}]`;
}

function parseTotalResults(value: unknown): number | undefined {
  let raw: unknown = value;
  if (raw && typeof raw === "object" && "#text" in (raw as Record<string, unknown>)) {
    raw = (raw as Record<string, unknown>)["#text"];
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
    // arXiv does not report citation counts; leave undefined so screening
    // can treat it as "unknown" instead of silently filtering as zero.
    citationCount: undefined,
    sources: ["arxiv"],
    sourceIds: { arxiv: arxivId ?? entry.id ?? "" },
  };
}

function clean(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
