import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { canonicalDoi, compact } from "../utils.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";

interface SemanticScholarPaper {
  paperId: string;
  title?: string;
  abstract?: string;
  year?: number;
  citationCount?: number;
  influentialCitationCount?: number;
  venue?: string;
  publicationVenue?: { name?: string };
  publicationDate?: string;
  url?: string;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
  };
  authors?: Array<{ name?: string }>;
}

interface SemanticScholarResponse {
  data?: SemanticScholarPaper[];
  total?: number;
  offset?: number;
  next?: number;
}

const FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "citationCount",
  "influentialCitationCount",
  "venue",
  "publicationVenue",
  "publicationDate",
  "url",
  "externalIds",
  "authors",
].join(",");

/**
 * Semantic Scholar enforces a rolling-window quota (observed: a handful of
 * requests succeeds, then 429 for roughly 60s, even with a valid key). Space
 * requests out so a multi-request run fits inside the window.
 */
const S2_THROTTLE_MS = 2500;

export async function searchSemanticScholarPage(
  options: SearchOptions,
  offset = 0,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const pageLimit = Math.min(Math.max(options.limit, 1), 100);
  const params = new URLSearchParams({
    query: options.topic,
    limit: String(pageLimit),
    offset: String(Math.max(offset, 0)),
    fields: FIELDS,
  });

  if (options.yearFrom || options.yearTo) {
    params.set("year", `${options.yearFrom ?? ""}-${options.yearTo ?? ""}`);
  }

  const headers: Record<string, string> = {};
  if (options.semanticScholarApiKey) headers["x-api-key"] = options.semanticScholarApiKey;

  const response = await fetchWithTimeout(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
    headers,
    throttleMs: S2_THROTTLE_MS,
    ...ctxOptions(ctx),
  });
  if (!response.ok) {
    throw new Error(`Semantic Scholar request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SemanticScholarResponse;
  const papers = (data.data ?? []).map(toPaper).filter((paper) => paper.title.length > 0);
  const total = data.total;
  const nextOffset =
    papers.length > 0 && total !== undefined && offset + papers.length < total ? offset + papers.length : undefined;
  return { papers, available: total, nextOffset };
}

export async function getSemanticScholarRecommendations(
  paperId: string,
  limit: number,
  apiKey?: string,
  ctx?: RequestCtx,
): Promise<Paper[]> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(limit, 1), 100)),
    fields: FIELDS,
  });
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  const response = await fetchWithTimeout(
    `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?${params}`,
    { headers, throttleMs: S2_THROTTLE_MS, ...ctxOptions(ctx) },
  );
  if (!response.ok) {
    throw new Error(`Semantic Scholar recommendations failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { recommendedPapers?: SemanticScholarPaper[] };
  return (data.recommendedPapers ?? []).map(toPaper).filter((paper) => paper.title.length > 0);
}

/**
 * Best-effort lightweight lookup of one S2 paper's external IDs, used by the
 * expand_related fallback to locate the seed in OpenAlex when the
 * recommendations endpoint rate-limits (429).
 */
export async function getSemanticScholarPaperExternalIds(
  paperId: string,
  apiKey?: string,
  ctx?: RequestCtx,
): Promise<{ doi?: string; arxivId?: string; title?: string }> {
  const params = new URLSearchParams({ fields: "externalIds,title" });
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  const response = await fetchWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}?${params}`,
    { headers, throttleMs: S2_THROTTLE_MS, ...ctxOptions(ctx) },
  );
  if (!response.ok) {
    throw new Error(`Semantic Scholar paper lookup failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as {
    title?: string;
    externalIds?: { DOI?: string; ArXiv?: string };
  };
  return {
    doi: canonicalDoi(data.externalIds?.DOI),
    arxivId: data.externalIds?.ArXiv,
    title: data.title,
  };
}

function toPaper(paper: SemanticScholarPaper): Paper {
  return {
    id: paper.paperId,
    title: paper.title ?? "",
    authors: compact((paper.authors ?? []).map((author) => author.name)),
    year: paper.year,
    publishedDate: paper.publicationDate,
    venue: paper.publicationVenue?.name ?? paper.venue,
    doi: canonicalDoi(paper.externalIds?.DOI),
    arxivId: paper.externalIds?.ArXiv,
    semanticScholarId: paper.paperId,
    url: paper.url,
    abstract: paper.abstract,
    citationCount: paper.citationCount,
    influentialCitationCount: paper.influentialCitationCount,
    sources: ["semantic_scholar"],
    sourceIds: { semantic_scholar: paper.paperId },
  };
}
