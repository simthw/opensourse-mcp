export type SourceName = "openalex" | "semantic_scholar" | "arxiv";

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  publishedDate?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  openalexId?: string;
  semanticScholarId?: string;
  url?: string;
  abstract?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  sources: SourceName[];
  sourceIds: Partial<Record<SourceName, string>>;
  score?: number;
  reasons?: string[];
}

export interface ScreeningCriteria {
  mustInclude?: string[];
  prefer?: string[];
  exclude?: string[];
  minCitations?: number;
  yearFrom?: number;
  yearTo?: number;
  includePreprints?: boolean;
}

export interface SearchOptions {
  topic: string;
  yearFrom?: number;
  yearTo?: number;
  limit: number;
  sources: SourceName[];
  includePreprints: boolean;
  semanticScholarApiKey?: string;
}

export interface ScreenedResult {
  topic: string;
  criteria: ScreeningCriteria;
  totalRawResults: number;
  totalDedupedCandidates: number;
  returned: number;
  results: Paper[];
  warnings: string[];
}
