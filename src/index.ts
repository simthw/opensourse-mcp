#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatScreenedResult } from "./format.js";
import { discoverAndScreen, expandRelated, type DiscoverInput } from "./workflow.js";
import type { ScreenedResult } from "./types.js";
import { exportToZotero } from "./providers/zotero.js";
import { generateResearchIdeas, reviewResearchIdea } from "./researchIdeas.js";

const sourceSchema = z.enum(["openalex", "semantic_scholar", "arxiv"]);

const screeningCriteriaSchema = z.object({
  mustInclude: z.array(z.string()).optional(),
  prefer: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  minCitations: z.number().int().min(0).optional(),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  includePreprints: z.boolean().optional(),
});

const paperSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()).default([]),
  year: z.number().optional(),
  publishedDate: z.string().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  arxivId: z.string().optional(),
  openalexId: z.string().optional(),
  semanticScholarId: z.string().optional(),
  url: z.string().optional(),
  abstract: z.string().optional(),
  citationCount: z.number().optional(),
  influentialCitationCount: z.number().optional(),
  sources: z.array(sourceSchema),
  sourceIds: z.record(z.string()).default({}),
  score: z.number().optional(),
  reasons: z.array(z.string()).optional(),
});

const discoverSchema = {
  topic: z.string().min(3).describe("Research topic or query."),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  perSourceLimit: z.number().int().min(1).max(200).optional(),
  sources: z.array(sourceSchema).default(["openalex", "semantic_scholar", "arxiv"]),
  includePreprints: z.boolean().default(true),
  screeningCriteria: screeningCriteriaSchema.optional(),
  semanticScholarApiKey: z.string().optional(),
};

const server = new McpServer({
  name: "opensource-literature-mcp",
  version: "0.1.0",
});

function toolResult(result: ScreenedResult) {
  return {
    content: [{ type: "text" as const, text: formatScreenedResult(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

const discoverHandler = async (args: DiscoverInput) => toolResult(await discoverAndScreen(args));

server.registerTool(
  "auto_literature_screen",
  {
    title: "Auto Literature Screen",
    description:
      "Search OpenAlex, Semantic Scholar, and arXiv, then internally merge, dedupe, screen, and rank papers. Returns only final selected papers.",
    inputSchema: discoverSchema,
  },
  discoverHandler,
);

server.registerTool(
  "discover_papers",
  {
    title: "Discover Papers",
    description:
      "Alias for auto_literature_screen. It keeps raw and deduped candidates internal and returns final selected papers only.",
    inputSchema: discoverSchema,
  },
  discoverHandler,
);

server.registerTool(
  "expand_related_papers",
  {
    title: "Expand Related Papers",
    description:
      "Use Semantic Scholar recommendations for a seed paper, then screen and rank related papers without exposing intermediate tables.",
    inputSchema: {
      semanticScholarPaperId: z.string().min(1),
      topic: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      screeningCriteria: screeningCriteriaSchema.optional(),
      semanticScholarApiKey: z.string().optional(),
    },
  },
  async (args) => {
    const result = await expandRelated(args);
    return toolResult(result);
  },
);

server.registerTool(
  "literature_mcp_health",
  {
    title: "Literature MCP Health",
    description: "Return server metadata and configured optional API keys.",
  },
  async () => ({
    content: [
      {
        type: "text",
        text: `opensource-literature-mcp 0.1.0\nSemantic Scholar API key configured: ${
          process.env.SEMANTIC_SCHOLAR_API_KEY ? "yes" : "no"
        }`,
      },
    ],
    structuredContent: {
      name: "opensource-literature-mcp",
      version: "0.1.0",
      semanticScholarApiKeyConfigured: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY),
    },
  }),
);

server.registerTool(
  "export_to_zotero",
  {
    title: "Export To Zotero",
    description:
      "Export selected final papers to a Zotero user or group library. Intended for results from auto_literature_screen.",
    inputSchema: {
      papers: z.array(paperSchema).min(1).max(100),
      zoteroApiKey: z.string().min(1),
      zoteroUserId: z.string().optional(),
      zoteroGroupId: z.string().optional(),
    },
  },
  async (args) => {
    const result = await exportToZotero({
      papers: args.papers,
      apiKey: args.zoteroApiKey,
      userId: args.zoteroUserId,
      groupId: args.zoteroGroupId,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Exported ${result.imported} papers to Zotero via ${result.endpoint}.`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "generate_research_ideas",
  {
    title: "Generate Research Ideas",
    description:
      "Produce heuristic, keyword-based research-idea scaffolding from a topic and selected papers. Ideas are derived from term overlap and research-gap templates, not from a language model, and scores are relative heuristics. Does not run experiments or execute code.",
    inputSchema: {
      topic: z.string().min(3),
      selected_papers: z.array(paperSchema).min(1).max(100),
      count: z.number().int().min(1).max(20).default(5),
      candidateMethods: z
        .array(z.string())
        .optional()
        .describe("Optional method phrases to look for in the selected papers (override the biomedical defaults)."),
      focusGaps: z
        .array(z.string())
        .optional()
        .describe("Optional research-gap phrases to consider alongside the generic defaults."),
    },
  },
  async (args) => {
    const ideas = generateResearchIdeas(args.topic, args.selected_papers, args.count, {
      candidateMethods: args.candidateMethods,
      focusGaps: args.focusGaps,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: ideas
            .map(
              (idea, index) =>
                `${index + 1}. ${idea.title}\nHypothesis: ${idea.hypothesis}\nEvidence: ${idea.evidencePapers.join("; ")}\nRisks: ${idea.risks.join("; ")}`,
            )
            .join("\n\n"),
        },
      ],
      structuredContent: { topic: args.topic, ideas },
    };
  },
);

server.registerTool(
  "review_research_idea",
  {
    title: "Review Research Idea",
    description:
      "Heuristically review a proposed research idea against selected papers, scoring novelty, feasibility, and literature support from keyword overlap. Scores are relative heuristics, not a language-model judgment.",
    inputSchema: {
      topic: z.string().min(3),
      idea: z.string().min(10),
      selected_papers: z.array(paperSchema).min(1).max(100),
    },
  },
  async (args) => {
    const review = reviewResearchIdea(args.topic, args.idea, args.selected_papers);
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Verdict: ${review.verdict} (${review.score}/100)`,
            `Novelty: ${review.novelty}/100`,
            `Feasibility: ${review.feasibility}/100`,
            `Evidence fit: ${review.evidenceFit}/100`,
            `Concerns: ${review.concerns.join("; ")}`,
            `Supporting papers: ${review.supportingPapers.join("; ")}`,
            `Suggested refinement: ${review.suggestedRefinement}`,
          ].join("\n"),
        },
      ],
      structuredContent: { topic: args.topic, idea: args.idea, review },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
