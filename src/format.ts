import type { Paper, ScreenedResult } from "./types.js";

export function formatScreenedResult(result: ScreenedResult): string {
  const lines = [
    `Selected ${result.returned} papers from ${result.totalDedupedCandidates} deduped candidates (${result.totalRawResults} raw results).`,
  ];

  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join("; ")}`);
  }

  result.results.forEach((paper, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${paper.title}`);
    lines.push(formatMeta(paper));
    if (paper.reasons?.length) lines.push(`Reason: ${paper.reasons.join("; ")}.`);
    if (paper.doi) lines.push(`DOI: ${paper.doi}`);
    if (paper.arxivId) lines.push(`arXiv: ${paper.arxivId}`);
    if (paper.url) lines.push(`URL: ${paper.url}`);
  });

  return lines.join("\n");
}

function formatMeta(paper: Paper): string {
  const authors = paper.authors.slice(0, 4).join(", ");
  const authorText = paper.authors.length > 4 ? `${authors}, et al.` : authors;
  return [
    authorText,
    paper.year,
    paper.venue,
    paper.citationCount !== undefined ? `${paper.citationCount} citations` : undefined,
    `sources: ${paper.sources.join(", ")}`,
    paper.score !== undefined ? `score: ${paper.score}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
}
