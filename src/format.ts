import type { Paper, ScreenedResult } from "./types.js";

/**
 * Abstracts are emitted so the calling model can judge topical relevance
 * itself; the MCP layer deliberately does not attempt that judgement.
 * Truncated to keep a large result set from crowding the caller's context.
 */
const ABSTRACT_PREVIEW_WORDS = 150;

export function formatScreenedResult(result: ScreenedResult): string {
  const lines = [
    `Selected ${result.returned} papers from ${result.totalDedupedCandidates} deduped candidates (${result.totalRawResults} raw results).`,
  ];

  if (result.sourceReports?.length) {
    for (const report of result.sourceReports) {
      const parts = [
        `${report.source}: retrieved ${report.retrieved} over ${report.pages} page(s)`,
        report.status && report.status !== "ok" ? `status: ${report.status}` : undefined,
        report.available !== undefined ? `available: ${report.available}` : undefined,
        report.durationMs !== undefined ? `${report.durationMs}ms` : undefined,
        report.note ? `(${report.note})` : undefined,
      ].filter(Boolean);
      lines.push(parts.join(" | "));
    }
  }

  if (result.retrieval) {
    const terms = result.retrieval.terms;
    const shown = terms.slice(0, 12).join(", ");
    const more = terms.length > 12 ? `, +${terms.length - 12} more` : "";
    lines.push(
      `Retrieval: ${result.retrieval.queries.length} query variant(s), ORed across providers (AND within each) | screening terms: ${shown}${more}`,
    );
  }

  if (result.rejectedBy && Object.keys(result.rejectedBy).length > 0) {
    lines.push(
      `Rejected by: ${Object.entries(result.rejectedBy)
        .map(([code, count]) => `${code}=${count}`)
        .join(", ")}`,
    );
  }

  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join("; ")}`);
  }

  if (result.rejectedDetails?.length) {
    lines.push("");
    lines.push(`Excluded (${result.rejectedDetails.length} shown):`);
    for (const record of result.rejectedDetails.slice(0, 25)) {
      lines.push(`- [${record.code}] ${record.title} — ${record.detail}`);
    }
    if (result.rejectedDetails.length > 25) {
      lines.push(`… +${result.rejectedDetails.length - 25} more`);
    }
  }

  result.results.forEach((paper, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${paper.title}`);
    lines.push(formatMeta(paper));
    if (paper.reasons?.length) lines.push(`Reason: ${paper.reasons.join("; ")}.`);
    if (paper.abstract) lines.push(`Abstract: ${truncateWords(paper.abstract, ABSTRACT_PREVIEW_WORDS)}`);
    if (paper.doi) lines.push(`DOI: ${paper.doi}`);
    if (paper.arxivId) lines.push(`arXiv: ${paper.arxivId}`);
    if (paper.url) lines.push(`URL: ${paper.url}`);
    if (paper.oaUrl) lines.push(`OA: ${paper.oaUrl}`);
  });

  if (result.seedReports?.length) {
    lines.push("");
    lines.push("Seed calibration:");
    for (const seed of result.seedReports) {
      const detail = seed.exclusionCode ? ` (excluded: ${seed.exclusionCode})` : "";
      lines.push(
        `- ${seed.seed} → ${seed.status}${detail}${seed.paperId ? ` [${seed.paperId}]` : ""}${seed.sources ? ` via ${seed.sources.join(", ")}` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

/** Truncate to at most `maxWords` words, marking the cut with an ellipsis. */
export function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/** Score decomposition, so a ranking position can be audited factor by factor. */
function breakdownText(paper: Paper): string | undefined {
  const b = paper.scoreBreakdown;
  if (!b) return undefined;
  const parts = [
    `terms ${b.topicTerms}`,
    `must ${b.mustPhrases}`,
    `prefer ${b.preferPhrases}`,
    `cross ${b.crossSource}`,
    `meta ${b.metadata}`,
    `cites ${b.citations}`,
    `infl ${b.influentialCitations}`,
    `recency ${b.recency}`,
  ];
  return `[${parts.join(" | ")}]`;
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
    breakdownText(paper),
  ]
    .filter(Boolean)
    .join(" | ");
}
