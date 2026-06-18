import type { Paper, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { compact, canonicalDoi, reconstructOpenAlexAbstract } from "../utils.js";

function contactEmail(): string {
  return process.env.OPENALEX_MAILTO?.trim() || "anonymous@example.com";
}

interface OpenAlexWork {
  id: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  cited_by_count?: number;
  primary_location?: {
    source?: { display_name?: string };
    landing_page_url?: string;
  };
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
  results?: OpenAlexWork[];
}

export async function searchOpenAlex(options: SearchOptions): Promise<Paper[]> {
  const perPage = Math.min(Math.max(options.limit, 1), 200);
  const params = new URLSearchParams({
    search: options.topic,
    per_page: String(perPage),
    sort: "relevance_score:desc",
    mailto: contactEmail(),
  });

  const filters: string[] = [];
  if (options.yearFrom) filters.push(`from_publication_date:${options.yearFrom}-01-01`);
  if (options.yearTo) filters.push(`to_publication_date:${options.yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));

  const response = await fetchWithTimeout(`https://api.openalex.org/works?${params}`, {
    headers: {
      "User-Agent": `opensource-literature-mcp/0.1 (mailto:${contactEmail()})`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAlex request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAlexResponse;
  return (data.results ?? []).map(toPaper).filter((paper) => paper.title.length > 0);
}

function toPaper(work: OpenAlexWork): Paper {
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
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    citationCount: work.cited_by_count,
    sources: ["openalex"],
    sourceIds: { openalex: work.id },
  };
}
