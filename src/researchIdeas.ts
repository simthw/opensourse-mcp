import type { Paper } from "./types.js";
import { normalizeText } from "./utils.js";

export interface ResearchIdea {
  title: string;
  hypothesis: string;
  rationale: string;
  methodSketch: string;
  expectedContribution: string;
  evidencePapers: string[];
  risks: string[];
  score: number;
}

export interface IdeaReview {
  verdict: "strong" | "promising" | "weak";
  score: number;
  novelty: number;
  feasibility: number;
  evidenceFit: number;
  concerns: string[];
  supportingPapers: string[];
  suggestedRefinement: string;
}

/**
 * Default candidate methods used only as a fallback. Callers working outside
 * biomedicine can override these via IdeaOptions.candidateMethods.
 */
const DEFAULT_METHOD_TERMS = [
  "contrastive learning",
  "graph neural network",
  "transformer",
  "foundation model",
  "multi-modal",
  "causal",
  "benchmark",
  "interpretable",
  "federated",
  "self-supervised",
];

export interface IdeaOptions {
  /** Candidate method phrases to look for in the selected papers. */
  candidateMethods?: string[];
  /** Extra research-gap phrases to consider alongside the generic defaults. */
  focusGaps?: string[];
}

export function generateResearchIdeas(
  topic: string,
  selectedPapers: Paper[],
  count = 5,
  options: IdeaOptions = {},
): ResearchIdea[] {
  const papers = selectedPapers.slice(0, 30);
  const topicTerms = importantTerms(topic);
  const corpus = normalizeText(papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" "));
  const candidateMethods = (options.candidateMethods?.length ? options.candidateMethods : DEFAULT_METHOD_TERMS).map(
    normalizeText,
  );
  const methodsInCorpus = candidateMethods.filter((term) => corpus.includes(term));
  // Prefer methods actually grounded in the selected papers; otherwise fall
  // back to salient topic terms so ideas stay tied to the user's query.
  const commonMethods = methodsInCorpus.length > 0 ? methodsInCorpus : topicTerms.slice(0, 4);
  const gaps = inferGaps(topic, corpus, options.focusGaps);

  const ideas = gaps.map((gap, index) => {
    const method = commonMethods[index % commonMethods.length] ?? "evidence-weighted modeling";
    const evidence = rankEvidencePapers(`${topic} ${gap} ${method}`, papers).slice(0, 4);
    // Score on grounded signals: evidence support and whether the chosen
    // method is actually attested in the selected papers.
    const methodGrounded = methodsInCorpus.includes(method) ? 15 : 0;
    const score = Math.round(60 + Math.min(25, evidence.length * 6) + methodGrounded);

    return {
      title: `${capitalize(gap)} for ${topic}`,
      hypothesis: `A ${method}-based approach can improve ${gap.toLowerCase()} in ${topic} compared with existing isolated analyses.`,
      rationale: `The selected papers indicate active work around ${joinList(topicTerms.slice(0, 5))}, but leave room for a focused study on ${gap.toLowerCase()}.`,
      methodSketch: `Use the selected papers as baselines, define a reproducible cohort or benchmark, compare against strong existing methods, and report ablations for ${method}.`,
      expectedContribution: `A clearer experimental recipe and evidence-backed method for ${gap.toLowerCase()} within ${topic}.`,
      evidencePapers: evidence.map((paper) => paper.title),
      risks: [
        "May need domain-specific datasets that are not available in the selected papers.",
        "Novelty depends on whether the closest baselines already solve the same problem.",
      ],
      score,
    };
  });

  return ideas.sort((a, b) => b.score - a.score).slice(0, Math.max(1, count));
}

export function reviewResearchIdea(topic: string, idea: string, selectedPapers: Paper[]): IdeaReview {
  const papers = selectedPapers.slice(0, 30);
  const ideaText = normalizeText(idea);
  const topicTerms = importantTerms(topic);
  const ideaTerms = importantTerms(idea);
  const evidence = rankEvidencePapers(`${topic} ${idea}`, papers).slice(0, 5);
  const corpus = normalizeText(papers.map((paper) => `${paper.title} ${paper.abstract ?? ""}`).join(" "));

  const topicOverlap = topicTerms.filter((term) => ideaText.includes(term)).length;
  const evidenceOverlap = ideaTerms.filter((term) => corpus.includes(term)).length;
  const noveltySignals = ideaTerms.filter((term) => !corpus.includes(term)).length;

  const evidenceFit = clampScore(35 + evidence.length * 10 + evidenceOverlap * 3);
  const feasibility = clampScore(50 + Math.min(25, evidence.length * 5) - (noveltySignals > 8 ? 10 : 0));
  const novelty = clampScore(45 + Math.min(30, noveltySignals * 4) + (topicOverlap > 0 ? 5 : -5));
  const score = Math.round(novelty * 0.35 + feasibility * 0.3 + evidenceFit * 0.35);

  const concerns: string[] = [];
  if (evidence.length < 3) concerns.push("Selected papers provide limited direct evidence; broaden literature screening before committing.");
  if (topicOverlap === 0) concerns.push("Idea wording does not clearly connect back to the topic.");
  if (noveltySignals < 2) concerns.push("Novelty may be incremental because most idea terms already appear in the selected literature.");
  if (noveltySignals > 10) concerns.push("High novelty signal may also mean the idea is under-supported by the selected papers.");
  if (concerns.length === 0) concerns.push("Main risk is experimental validation quality rather than literature fit.");

  return {
    verdict: score >= 78 ? "strong" : score >= 60 ? "promising" : "weak",
    score,
    novelty,
    feasibility,
    evidenceFit,
    concerns,
    supportingPapers: evidence.map((paper) => paper.title),
    suggestedRefinement: buildRefinement(topic, ideaTerms, evidence),
  };
}

function inferGaps(topic: string, corpus: string, focusGaps: string[] = []): string[] {
  // Domain-neutral research gaps that apply across most fields.
  const gaps = [
    ...focusGaps,
    "reproducible benchmarking",
    "cross-dataset generalization",
    "data-efficient model comparison",
    "robustness under distribution shift",
    "interpretability and error analysis",
    "ablation-driven method validation",
  ];

  // Lightweight, opt-in domain augmentation triggered only when the selected
  // papers actually mention the relevant terms.
  if (corpus.includes("single cell") || corpus.includes("single-cell")) gaps.unshift("cell-type aware prediction");
  if (corpus.includes("survival")) gaps.unshift("survival endpoint calibration");
  if (corpus.includes("benchmark")) gaps.push("standardized benchmark construction");
  if (normalizeText(topic).includes("cancer")) gaps.unshift("cancer subtype transfer");

  return [...new Set(gaps.map((gap) => gap.trim()).filter(Boolean))];
}

function rankEvidencePapers(query: string, papers: Paper[]): Paper[] {
  const terms = importantTerms(query);
  return papers
    .map((paper) => {
      const text = normalizeText(`${paper.title} ${paper.abstract ?? ""}`);
      const matches = terms.filter((term) => text.includes(term)).length;
      const citations = Math.min(10, Math.log10((paper.citationCount ?? 0) + 1) * 4);
      return { paper, score: matches * 5 + citations + (paper.sources.length > 1 ? 4 : 0) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.paper);
}

function importantTerms(text: string): string[] {
  const stop = new Set(["and", "the", "for", "with", "from", "that", "this", "into", "using", "based", "study"]);
  return normalizeText(text)
    .split(" ")
    .filter((term) => term.length > 2 && !stop.has(term))
    .slice(0, 40);
}

function buildRefinement(topic: string, ideaTerms: string[], evidence: Paper[]): string {
  const anchor = evidence[0]?.title ?? "the strongest selected baseline";
  const terms = joinList(ideaTerms.slice(0, 4));
  return `Frame the idea as a testable comparison against "${anchor}", specify datasets and metrics, and make ${terms || topic} the measurable contribution.`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinList(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}
