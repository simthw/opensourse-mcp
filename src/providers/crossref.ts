import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { canonicalDoi, compact } from "../utils.js";
import { variantGroups } from "../queryPlan.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";

const BASE_URL = "https://api.crossref.org/works";
const MAX_PAGE = 100;

/**
 * Crossref indexes much more than articles (journal issues, datasets, peer
 * reviews). Only these scholarly types are fetched; everything else is noise
 * for a literature search.
 */
const SCHOLARLY_TYPES = new Set([
  "journal-article",
  "proceedings-article",
  "book-chapter",
  "posted-content",
  "report",
  "monograph",
  "book",
  "dissertation",
]);

function contactEmail(): string {
  return (
    process.env.CROSSREF_MAILTO?.trim() ||
    process.env.OPENALEX_MAILTO?.trim() ||
    "anonymous@example.com"
  );
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  "is-referenced-by-count"?: number;
  abstract?: string;
  URL?: string;
  type?: string;
}

interface CrossrefResponse {
  message?: { "total-results"?: number; items?: CrossrefWork[] };
}

const SELECT = "DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,type";

/**
 * Crossref search. Crossref's query is a relevance query, not a strict AND, so
 * every variant's content words are simply passed through: the provider ranks,
 * screening decides. `select` keeps payloads small.
 */
export async function searchCrossrefPage(
  options: SearchOptions,
  offset = 0,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const words = [
    ...new Set(variantGroups(options.topic, options.variants).flat()),
  ].slice(0, 20);
  if (words.length === 0) {
    throw new Error(`Topic produced no searchable tokens: "${options.topic}"`);
  }

  const params = new URLSearchParams({
    "query.bibliographic": words.join(" "),
    rows: String(Math.min(Math.max(options.limit, 1), MAX_PAGE)),
    offset: String(Math.max(offset, 0)),
    select: SELECT,
    mailto: contactEmail(),
  });

  const filters: string[] = [];
  if (options.yearFrom) filters.push(`from-pub-date:${options.yearFrom}-01-01`);
  if (options.yearTo) filters.push(`until-pub-date:${options.yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));

  const response = await fetchWithTimeout(`${BASE_URL}?${params}`, {
    headers: {
      "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contactEmail()})`,
    },
    // Crossref's polite pool is generous, but pace a little anyway.
    throttleMs: 200,
    ...ctxOptions(ctx),
  });
  if (!response.ok) {
    throw new Error(`Crossref request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as CrossrefResponse;
  const items = data.message?.items ?? [];
  const available = data.message?.["total-results"];
  const papers = items
    .filter((work) => !work.type || SCHOLARLY_TYPES.has(work.type))
    .map(toPaper)
    .filter((paper) => paper.title.length > 0);

  const nextOffset =
    items.length > 0 && available !== undefined && offset + items.length < available
      ? offset + items.length
      : undefined;

  return { papers, available, nextOffset };
}

function toPaper(work: CrossrefWork): Paper {
  const doi = canonicalDoi(work.DOI);
  const year = work.issued?.["date-parts"]?.[0]?.[0];
  const isPreprint = work.type === "posted-content";
  return {
    id: doi ?? work.URL ?? (work.title?.[0] ?? ""),
    title: clean(work.title?.[0]),
    authors: compact(
      (work.author ?? []).map((author) => author.name ?? [author.given, author.family].filter(Boolean).join(" ")),
    ),
    year: typeof year === "number" ? year : undefined,
    venue: work["container-title"]?.[0] ?? (isPreprint ? "Preprint (Crossref)" : undefined),
    doi,
    url: work.URL ?? (doi ? `https://doi.org/${doi}` : undefined),
    abstract: work.abstract ? clean(stripTags(work.abstract)) : undefined,
    citationCount: work["is-referenced-by-count"],
    isPreprint,
    sources: ["crossref"],
    sourceIds: { crossref: doi ?? work.URL ?? "" },
  };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function clean(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
