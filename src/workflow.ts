import { searchArxiv } from "./providers/arxiv.js";
import { searchOpenAlex } from "./providers/openalex.js";
import { getSemanticScholarRecommendations, searchSemanticScholar } from "./providers/semanticScholar.js";
import { screenAndRank } from "./screening.js";
import type { Paper, ScreenedResult, ScreeningCriteria, SearchOptions, SourceName } from "./types.js";
import { mergePapers } from "./utils.js";

export interface DiscoverInput {
  topic: string;
  yearFrom?: number;
  yearTo?: number;
  limit?: number;
  perSourceLimit?: number;
  sources?: SourceName[];
  includePreprints?: boolean;
  screeningCriteria?: ScreeningCriteria;
  semanticScholarApiKey?: string;
}

export async function discoverAndScreen(input: DiscoverInput): Promise<ScreenedResult> {
  const limit = input.limit ?? 20;
  const criteria: ScreeningCriteria = {
    ...input.screeningCriteria,
    yearFrom: input.screeningCriteria?.yearFrom ?? input.yearFrom,
    yearTo: input.screeningCriteria?.yearTo ?? input.yearTo,
    includePreprints: input.screeningCriteria?.includePreprints ?? input.includePreprints ?? true,
  };
  const sources = input.sources ?? ["openalex", "semantic_scholar", "arxiv"];
  const options: SearchOptions = {
    topic: input.topic,
    yearFrom: criteria.yearFrom,
    yearTo: criteria.yearTo,
    limit: input.perSourceLimit ?? Math.max(limit * 3, 30),
    sources,
    includePreprints: criteria.includePreprints ?? true,
    semanticScholarApiKey: input.semanticScholarApiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY,
  };

  const warnings: string[] = [];
  const batches = await Promise.all(
    sources.map(async (source) => {
      try {
        return await searchSource(source, options);
      } catch (error) {
        warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }),
  );

  const raw = batches.flat();
  const deduped = mergePapers(raw);
  const results = screenAndRank(input.topic, deduped, criteria, limit);

  return {
    topic: input.topic,
    criteria,
    totalRawResults: raw.length,
    totalDedupedCandidates: deduped.length,
    returned: results.length,
    results,
    warnings,
  };
}

export async function expandRelated(input: {
  semanticScholarPaperId: string;
  topic?: string;
  limit?: number;
  screeningCriteria?: ScreeningCriteria;
  semanticScholarApiKey?: string;
}): Promise<ScreenedResult> {
  const topic = input.topic ?? input.semanticScholarPaperId;
  const limit = input.limit ?? 20;
  const warnings: string[] = [];
  let papers: Paper[] = [];

  try {
    papers = await getSemanticScholarRecommendations(
      input.semanticScholarPaperId,
      Math.max(limit * 3, 30),
      input.semanticScholarApiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY,
    );
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const deduped = mergePapers(papers);
  const results = screenAndRank(topic, deduped, input.screeningCriteria ?? {}, limit);

  return {
    topic,
    criteria: input.screeningCriteria ?? {},
    totalRawResults: papers.length,
    totalDedupedCandidates: deduped.length,
    returned: results.length,
    results,
    warnings,
  };
}

async function searchSource(source: SourceName, options: SearchOptions): Promise<Paper[]> {
  if (source === "openalex") return searchOpenAlex(options);
  if (source === "semantic_scholar") return searchSemanticScholar(options);
  return searchArxiv(options);
}
