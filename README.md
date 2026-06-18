# Open Source Literature MCP

An MCP server for automatic literature discovery and screening across OpenAlex, Semantic Scholar, and arXiv.

The server keeps intermediate raw results, normalized records, and deduped candidates internal. MCP clients receive only the final selected papers plus structured metadata.

## Tools

- `auto_literature_screen`: Searches selected sources, dedupes by DOI/arXiv ID/title, screens, ranks, and returns final papers.
- `discover_papers`: Alias for `auto_literature_screen`.
- `expand_related_papers`: Expands a Semantic Scholar seed paper with related recommendations, then screens and ranks.
- `export_to_zotero`: Exports final selected papers to a Zotero user or group library.
- `generate_research_ideas`: Generates evidence-backed research ideas from a topic and selected papers.
- `review_research_idea`: Reviews one proposed idea against selected papers for novelty, feasibility, and evidence fit.
- `literature_mcp_health`: Shows server metadata and whether a Semantic Scholar API key is configured.

## Setup

```bash
npm install
npm run build
npm test
```

Optional environment variables (PowerShell):

```powershell
$env:SEMANTIC_SCHOLAR_API_KEY = "your_key"
$env:OPENALEX_MAILTO = "you@example.com"
```

Or with `bash`:

```bash
export SEMANTIC_SCHOLAR_API_KEY=your_key
export OPENALEX_MAILTO=you@example.com
```

Semantic Scholar works without a key, but a key usually improves rate limits.
`OPENALEX_MAILTO` opts into OpenAlex's faster "polite pool"; set it to a real contact email.

## MCP Client Config

Use the built server:

```json
{
  "mcpServers": {
    "opensource-literature": {
      "command": "node",
      "args": ["D:/demo/opensourse-mcp/dist/index.js"]
    }
  }
}
```

## Zotero Export

Call `export_to_zotero` with the `results` array returned by `auto_literature_screen`.

```json
{
  "papers": [],
  "zoteroApiKey": "your_zotero_key",
  "zoteroUserId": "123456"
}
```

Use `zoteroGroupId` instead of `zoteroUserId` for a group library.

## Research Ideas

These two tools are heuristic scaffolding, not a language-model judgment. Ideas come from keyword/term overlap and research-gap templates, and the scores are relative heuristics meant to triage, not to rank definitively. The method and gap vocabularies default to a biomedical bias; override them with `candidateMethods` and `focusGaps` for other fields.

Use the `results` array returned by `auto_literature_screen` as `selected_papers`.

```json
{
  "topic": "single-cell multi-omics integration cancer prognosis",
  "selected_papers": [],
  "count": 5
}
```

Then review a specific idea:

```json
{
  "topic": "single-cell multi-omics integration cancer prognosis",
  "idea": "Build a cell-type aware survival prediction benchmark for missing-modality single-cell multi-omics data.",
  "selected_papers": []
}
```

For development:

```json
{
  "mcpServers": {
    "opensource-literature-dev": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "D:/demo/opensourse-mcp"
    }
  }
}
```

## Example Call

```json
{
  "topic": "single-cell multi-omics integration cancer prognosis",
  "yearFrom": 2020,
  "limit": 10,
  "sources": ["openalex", "semantic_scholar", "arxiv"],
  "includePreprints": true,
  "screeningCriteria": {
    "mustInclude": ["single-cell"],
    "prefer": ["multi-omics", "cancer prognosis", "survival prediction"],
    "exclude": ["review", "editorial", "protocol"],
    "minCitations": 5
  }
}
```

## Implementation Notes

Scoring combines:

- query term overlap in title/abstract
- required and preferred phrases
- DOI/arXiv metadata quality
- cross-source confirmation
- citation counts
- recency

Intermediate candidate tables are intentionally not exposed as a workflow step.
