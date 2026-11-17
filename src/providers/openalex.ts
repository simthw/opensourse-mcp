import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { compact, canonicalDoi, reconstructOpenAlexAbstract } from "../utils.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";
import { variantGroups } from "../queryPlan.js";

function contactEmail(): string {
  return process.env.OPENALEX_MAILTO?.trim() || "anonymous@example.com";
}

function openAlexApiKey(): string | undefined {
  return process.env.OPENALEX_API_KEY?.trim() || undefined;
}

const MAX_PAGE = 200;

interface OpenAlexWork {
  id: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  type?: string;
  cited_by_count?: number;
  is_retracted?: boolean;
  open_access?: { is_oa?: boolean; oa_url?: string };
  primary_location?: {
    source?: { display_name?: string };
    landing_page_url?: string;
  };
  related_works?: string[];
  host_venue?: {
    display_name?: string;
    url?: string;
  };
  authorships?: Array<{
    author?: { display_name?: string };
  }>;
  abstract_inverted_index?: Record<string, number[]>;
  ids?: {
    doi?: string;
    openalex?: string;
  };
}

interface OpenAlexResponse {
  meta?: { count?: number; next_cursor?: string };
  results?: OpenAlexWork[];
}

const SELECT_FIELDS = [
  "id",
  "doi",
  "ids",
  "display_name",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "open_access",
  "primary_location",
  "authorships",
  "abstract_inverted_index",
].join(",");

/**
 * The seed-record lookups need `related_works`, which the search payload
 * deliberately omits (a single work's related list is only useful for the
 * expansion fallback). Asking for it via a separate select keeps the search
 * responses small.
 */
const SELECT_FIELDS_WITH_RELATED = `${SELECT_FIELDS},related_works`;

export async function searchOpenAlexPage(
  options: SearchOptions,
  cursor?: string,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const perPage = Math.min(Math.max(options.limit, 1), MAX_PAGE);
  const params = new URLSearchParams({
    per_page: String(perPage),
    sort: "relevance_score:desc",
    mailto: contactEmail(),
    select: SELECT_FIELDS,
  });
  const apiKey = openAlexApiKey();
  if (apiKey) params.set("api_key", apiKey);

  // Server-side filtering keeps precision and relevance truncation aligned:
  // search the title+abstract index instead of the default fulltext index,
  // and push citation / retraction / type constraints down before paging.
  const filters: string[] = [];
  // Unquoted token search over the title+abstract index: OpenAlex ANDs the
  // words inside a group and ORs the parenthesised groups, so several
  // phrasings of the same concept all retrieve. With one variant this is the
  // original single AND query.
  const groups = variantGroups(options.topic, options.variants).map((tokens) => tokens.join(" "));
  if (groups.length > 0) {
    const value = groups.length === 1 ? groups[0] : groups.map((group) => `(${group})`).join(" OR ");
    filters.push(`title_and_abstract.search:${value}`);
  }
  if (options.yearFrom) filters.push(`from_publication_date:${options.yearFrom}-01-01`);
  if (options.yearTo) filters.push(`to_publication_date:${options.yearTo}-12-31`);
  if (options.minCitations !== undefined && options.minCitations > 0) {
    filters.push(`cited_by_count:>${options.minCitations - 1}`);
  }
  // Retractions are excluded by default; includeRetracted opts back in.
  if (!options.includeRetracted) filters.push("is_retracted:false");
  // Only restrict to journal articles when the caller already opted out of
  // preprints; otherwise OpenAlex "preprint"-type records stay eligible.
  if (options.includePreprints === false) filters.push("type:article");

  if (filters.length > 0) params.set("filter", filters.join(","));
  params.set("cursor", cursor && cursor.length > 0 ? cursor : "*");

  const response = await fetchWithTimeout(`https://api.openalex.org/works?${params}`, {
    headers: {
      "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contactEmail()})`,
    },
    ...ctxOptions(ctx),
  });

  if (!response.ok) {
    throw new Error(`OpenAlex request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAlexResponse;
  return {
    papers: (data.results ?? []).map(toPaper).filter((paper) => paper.title.length > 0),
    available: data.meta?.count,
    nextCursor: data.meta?.next_cursor,
  };
}

export function toPaper(work: OpenAlexWork): Paper {
  const doi = canonicalDoi(work.doi ?? work.ids?.doi);
  const venue = work.primary_location?.source?.display_name ?? work.host_venue?.display_name;
  const url = work.primary_location?.landing_page_url ?? work.host_venue?.url ?? work.id;

  return {
    id: work.id,
    title: work.title ?? work.display_name ?? "",
    authors: compact((work.authorships ?? []).map((authorship) => authorship.author?.display_name)),
    year: work.publication_year,
    publishedDate: work.publication_date,
    venue,
    doi,
    openalexId: work.id,
    url,
    oaUrl: work.open_access?.oa_url,
    openAccess: work.open_access?.is_oa,
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    citationCount: work.cited_by_count,
    sources: ["openalex"],
    sourceIds: { openalex: work.id },
  };
}

/**
 * Fetch a batch of OpenAlex works by their OpenAlex IDs (used for the
 * Semantic Scholar fallback via a seed record's related_works list).
 */
export async function fetchOpenAlexByIds(ids: string[], apiKey?: string, ctx?: RequestCtx): Promise<Paper[]> {
  if (ids.length === 0) return [];
  // related_works entries are full URLs ("https://openalex.org/W123"); the
  // filter expects the bare work ID. Passing full URLs bloats the query
  // string until OpenAlex rejects it, so normalise first.
  const shortIds = ids
    .map((id) => id.replace(/^https?:\/\/openalex\.org\//i, "").trim())
    .filter(Boolean)
    .slice(0, 50);

  const params = new URLSearchParams({
    filter: `openalex_id:${shortIds.join("|")}`,
    per_page: String(Math.min(shortIds.length, 50)),
    select: SELECT_FIELDS,
    mailto: contactEmail(),
  });
  if (apiKey) params.set("api_key", apiKey);

  const response = await fetchWithTimeout(`https://api.openalex.org/works?${params}`, {
    headers: {
      "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contactEmail()})`,
    },
    ...ctxOptions(ctx),
  });
  if (!response.ok) {
    throw new Error(`OpenAlex request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as OpenAlexResponse;
  return (data.results ?? []).map(toPaper).filter((paper) => paper.title.length > 0);
}

/** Resolve the OpenAlex record for a seed paper identified by DOI. */
export async function fetchOpenAlexWorkByDoi(
  doi: string,
  apiKey?: string,
  ctx?: RequestCtx,
): Promise<OpenAlexWork | undefined> {
  // related_works must be requested explicitly: it is not part of the search
  // select list, and without it the expansion fallback silently sees an
  // empty related list.
  const params = new URLSearchParams({ mailto: contactEmail(), select: SELECT_FIELDS_WITH_RELATED });
  if (apiKey) params.set("api_key", apiKey);
  const response = await fetchWithTimeout(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?${params}`,
    {
      headers: {
        "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contactEmail()})`,
      },
      ...ctxOptions(ctx),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`OpenAlex request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as OpenAlexWork;
}
