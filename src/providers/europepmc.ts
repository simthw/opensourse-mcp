import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { canonicalDoi, compact } from "../utils.js";
import { variantGroups } from "../queryPlan.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";

const BASE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const MAX_PAGE = 200;

interface EuropePmcResult {
  id?: string | number;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  firstPublicationDate?: string;
  citedByCount?: string | number;
  journalInfo?: { journal?: { title?: string } };
  isOpenAccess?: string;
  abstractText?: string;
  source?: string;
}

interface EuropePmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: EuropePmcResult[] | EuropePmcResult };
}

/**
 * Europe PMC search with `resultType=core`, cursor-based pagination
 * (nextCursorMark), and `SRC:PPR` preprint coverage. Tokens are ANDed over
 * the title/abstract fields so precision matches the arXiv/OpenAlex fixes.
 */
export async function searchEuropePmcPage(
  options: SearchOptions,
  cursor?: string,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const groups = variantGroups(options.topic, options.variants).map((tokens) =>
    tokens.map((token) => `(TITLE:"${token}" OR ABSTRACT:"${token}")`).join(" AND "),
  );
  if (groups.length === 0) {
    throw new Error(`Topic produced no searchable tokens: "${options.topic}"`);
  }

  const clauses: string[] = [
    groups.length === 1 ? groups[0] : `(${groups.join(" OR ")})`,
  ];
  // Europe PMC indexes preprints (SRC:"PPR") alongside journal articles by
  // default; only add a server-side clause when preprints are excluded.
  if (options.includePreprints === false) {
    clauses.push('NOT SRC:"PPR"');
  }
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getUTCFullYear();
    clauses.push(`(PUB_YEAR:[${from} TO ${to}])`);
  }

  const params = new URLSearchParams({
    query: clauses.join(" AND "),
    format: "json",
    resultType: "core",
    pageSize: String(Math.min(Math.max(options.limit, 1), MAX_PAGE)),
    // Europe PMC pages with `cursorMark`, not `cursor`. Sending the wrong name
    // is silently ignored: every page then returns page 1 again, so a backfill
    // re-reads the same records (and dedupes them away).
    cursorMark: cursor && cursor.length > 0 ? cursor : "*",
    // Europe PMC's default relevance ranking is recency-heavy (its top slice
    // is dominated by brand-new preprints), which rarely overlaps with
    // OpenAlex's relevance slice. Sorting by citation count retrieves the
    // foundational literature, so cross-source confirmation does not depend
    // on Semantic Scholar availability. Screening re-ranks everything anyway.
    sort: "CITED desc",
  });
  const email = process.env.EUROPEPMC_EMAIL?.trim();
  if (email) params.set("email", email);

  const response = await fetchWithTimeout(`${BASE_URL}?${params}`, { ...ctxOptions(ctx) });
  if (!response.ok) {
    throw new Error(`Europe PMC request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as EuropePmcResponse;
  const results = data.resultList?.result;
  const papers = (Array.isArray(results) ? results : compact([results]))
    .map(toPaper)
    .filter((paper) => paper.title.length > 0);

  return {
    papers,
    available: data.hitCount,
    nextCursor: data.nextCursorMark,
  };
}

function toPaper(result: EuropePmcResult): Paper {
  const doi = canonicalDoi(result.doi);
  const year = result.pubYear ? Number(result.pubYear) : undefined;
  const pmid = result.pmid ? String(result.pmid) : undefined;
  const id = `europepmc:${result.id ?? pmid ?? doi ?? clean(result.title)}`;
  const isPreprint = result.source === "PPR";

  return {
    id,
    title: clean(result.title),
    authors: clean(result.authorString)
      .split(",")
      .map((author) => author.trim())
      .filter(Boolean),
    year: Number.isFinite(year) ? year : undefined,
    publishedDate: result.firstPublicationDate,
    venue: result.journalInfo?.journal?.title ?? (isPreprint ? "Preprint (Europe PMC)" : undefined),
    doi,
    pmid,
    url: doi
      ? `https://doi.org/${doi}`
      : pmid
        ? `https://europepmc.org/article/MED/${pmid}`
        : `https://europepmc.org/search?query=${encodeURIComponent(id)}`,
    openAccess: result.isOpenAccess === "Y" ? true : result.isOpenAccess === "N" ? false : undefined,
    abstract: result.abstractText ? clean(result.abstractText) : undefined,
    citationCount: parseCount(result.citedByCount),
    sources: ["europepmc"],
    sourceIds: { europepmc: String(result.id ?? pmid ?? "") },
  };
}

function parseCount(value?: string | number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function clean(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
