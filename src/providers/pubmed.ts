import { XMLParser } from "fast-xml-parser";
import type { Paper, ProviderPage, SearchOptions } from "../types.js";
import { fetchWithTimeout } from "../http.js";
import { compact, canonicalDoi } from "../utils.js";
import { variantGroups } from "../queryPlan.js";
import { ctxOptions, type RequestCtx } from "../deadline.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const MAX_PAGE = 100;
/** NCBI allows 3 requests/second without an API key; stay well under it. */
const NCBI_THROTTLE_MS = 400;

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: false });

function contactEmail(): string {
  return (
    process.env.NCBI_EMAIL?.trim() ||
    process.env.EUROPEPMC_EMAIL?.trim() ||
    "anonymous@example.com"
  );
}

interface EsSearchResult {
  esearchresult?: { count?: string; idlist?: string[] };
}

/**
 * PubMed search via NCBI E-utilities: esearch for PMIDs, then efetch for the
 * abstracts. PubMed's query language ANDs terms and ORs the variant groups,
 * mirroring the other providers: `x[tiab] AND y[tiab]` per variant.
 */
export async function searchPubMedPage(
  options: SearchOptions,
  offset = 0,
  ctx?: RequestCtx,
): Promise<ProviderPage> {
  const groups = variantGroups(options.topic, options.variants).map((tokens) =>
    tokens.map((token) => `${token}[tiab]`).join(" AND "),
  );
  if (groups.length === 0) {
    throw new Error(`Topic produced no searchable tokens: "${options.topic}"`);
  }
  const term = groups.length === 1 ? groups[0] : `(${groups.join(" OR ")})`;

  const search = new URLSearchParams({
    db: "pubmed",
    term,
    retmode: "json",
    retmax: String(Math.min(Math.max(options.limit, 1), MAX_PAGE)),
    retstart: String(Math.max(offset, 0)),
    sort: "relevance",
    tool: "opensource-literature-mcp",
    email: contactEmail(),
  });
  if (options.yearFrom || options.yearTo) {
    search.set("datetype", "pdat");
    search.set("mindate", `${options.yearFrom ?? 1900}`);
    search.set("maxdate", `${options.yearTo ?? new Date().getUTCFullYear()}`);
    search.set("reldate", "");
    search.delete("reldate");
  }

  const searchResponse = await fetchWithTimeout(`${EUTILS}/esearch.fcgi?${search}`, {
    throttleMs: NCBI_THROTTLE_MS,
    ...ctxOptions(ctx, { timeoutMs: 20000 }),
  });
  if (!searchResponse.ok) {
    throw new Error(`PubMed esearch failed: ${searchResponse.status} ${searchResponse.statusText}`);
  }
  const searchData = (await searchResponse.json()) as EsSearchResult;
  const ids = searchData.esearchresult?.idlist ?? [];
  const count = Number(searchData.esearchresult?.count ?? 0);
  const available = Number.isFinite(count) ? count : undefined;

  if (ids.length === 0) {
    return { papers: [], available, nextOffset: undefined };
  }

  const fetchParams = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    rettype: "abstract",
    retmode: "xml",
    tool: "opensource-literature-mcp",
    email: contactEmail(),
  });
  const fetchResponse = await fetchWithTimeout(`${EUTILS}/efetch.fcgi?${fetchParams}`, {
    throttleMs: NCBI_THROTTLE_MS,
    ...ctxOptions(ctx, { timeoutMs: 20000 }),
  });
  if (!fetchResponse.ok) {
    throw new Error(`PubMed efetch failed: ${fetchResponse.status} ${fetchResponse.statusText}`);
  }

  const xml = await fetchResponse.text();
  const papers = parseArticles(xml);

  const nextOffset =
    papers.length > 0 && available !== undefined && offset + papers.length < available
      ? offset + papers.length
      : undefined;

  return { papers, available, nextOffset };
}

interface ParsedArticle {
  pmid: string;
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
}

function parseArticles(xml: string): Paper[] {
  const data = parser.parse(xml) as Record<string, any>;
  const set = data?.PubmedArticleSet?.PubmedArticle ?? [];
  const articles = (Array.isArray(set) ? set : [set]).filter(Boolean);

  return articles.map((entry: any) => {
    const citation = entry?.MedlineCitation ?? {};
    const article = citation?.Article ?? {};
    const journal = article?.Journal ?? {};
    const pubDate = journal?.JournalIssue?.PubDate ?? {};
    const idList = toArray(entry?.PubmedArticle?.ArticleIdList?.ArticleId ?? entry?.ArticleIdList?.ArticleId);

    const pmid = flattenText(citation?.PMID) ?? "";
    const doi = idList
      .map((id: any) => ({
        type: String(id?.["@_IdType"] ?? "").toLowerCase(),
        value: flattenText(id) ?? "",
      }))
      .find((id: { type: string }) => id.type === "doi")?.value;

    const yearText = flattenText(pubDate?.Year) ?? flattenText(pubDate?.MedlineDate) ?? "";
    const year = Number(yearText.slice(0, 4));

    const record: ParsedArticle = {
      pmid,
      title: flattenText(article?.ArticleTitle) ?? "",
      abstract: parseAbstract(article?.Abstract),
      authors: parseAuthors(article?.AuthorList?.Author),
      year: Number.isFinite(year) && year > 0 ? year : undefined,
      venue: flattenText(journal?.Title) ?? undefined,
      doi: canonicalDoi(doi),
    };
    return toPaper(record);
  });
}

function parseAbstract(abstract: any): string | undefined {
  const parts = toArray(abstract?.AbstractText);
  if (parts.length === 0) return undefined;
  const text = parts
    .map((part: any) => {
      const label = part?.["@_Label"];
      const body = flattenText(part) ?? "";
      return label ? `${label}: ${body}` : body;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : undefined;
}

function parseAuthors(author: any): string[] {
  return compact(
    toArray(author).map((entry: any) => {
      const collective = flattenText(entry?.CollectiveName);
      if (collective) return collective;
      const last = flattenText(entry?.LastName);
      const fore = flattenText(entry?.ForeName) ?? flattenText(entry?.Initials);
      return [fore, last].filter(Boolean).join(" ");
    }),
  ).filter((name) => name.length > 0);
}

function toPaper(record: ParsedArticle): Paper {
  return {
    id: record.pmid ? `pubmed:${record.pmid}` : (record.doi ?? record.title),
    title: record.title,
    authors: record.authors,
    year: record.year,
    venue: record.venue,
    doi: record.doi,
    pmid: record.pmid || undefined,
    url: record.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`
      : record.doi
        ? `https://doi.org/${record.doi}`
        : undefined,
    abstract: record.abstract,
    // PubMed does not report citation counts; leave undefined ("unknown"),
    // matching the arXiv behaviour, instead of a misleading 0.
    citationCount: undefined,
    isPreprint: false,
    sources: ["pubmed"],
    sourceIds: { pubmed: record.pmid },
  };
}

function toArray(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** fast-xml-parser turns mixed content into objects; collect the text parts. */
function flattenText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return compact(value.map(flattenText)).join(" ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    if (record["#text"] !== undefined) parts.push(String(record["#text"]));
    for (const [key, nested] of Object.entries(record)) {
      if (key.startsWith("@_") || key === "#text") continue;
      const text = flattenText(nested);
      if (text) parts.push(text);
    }
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}
