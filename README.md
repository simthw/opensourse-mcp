# Open Source Literature MCP

An MCP server for automatic literature discovery and screening across OpenAlex, Europe PMC, Semantic Scholar, arXiv, PubMed, and Crossref.

Every search call runs under a hard wall-clock deadline (default 50s, `LITERATURE_MCP_DEADLINE_MS` or per-call `deadlineMs`) with MCP cancellation propagated to every request: slow or rate-limited sources are dropped instead of blocking the others, the call returns partial results with per-source status, and a cancelled call stops consuming upstream quota immediately.

The server keeps intermediate raw results, normalized records, and deduped candidates internal. MCP clients receive only the final selected papers plus structured metadata.

## Tools

- `auto_literature_screen`: Searches selected sources, dedupes by DOI/arXiv ID/OpenAlex ID/title, screens, ranks, and returns final papers. Accepts `queries`: alternative phrasings of the topic for recall (see below).
- `discover_papers`: Alias for `auto_literature_screen`.
- `expand_related_papers`: Expands a Semantic Scholar seed paper with related recommendations, then screens and ranks. If Semantic Scholar rate-limits the request, it degrades to the seed record's `related_works` from OpenAlex.
- `export_to_zotero`: Exports final selected papers to a Zotero user or group library.
- `generate_research_ideas`: Generates evidence-backed research ideas from a topic and selected papers.
- `review_research_idea`: Reviews one proposed idea against selected papers for novelty, feasibility, and evidence fit.
- `literature_mcp_health`: Shows server metadata, whether API keys are configured, and live status checks for OpenAlex, Europe PMC, Semantic Scholar, and arXiv.

## Setup

```bash
npm install
npm run build
npm test
```

`npm test` covers unit behavior, including the deadline/cancellation
regression suite (`test/resilience.test.ts`: long Retry-After, stalled body,
stuck backfill, client cancel — each followed by a normal query). To exercise
every MCP tool end-to-end over stdio against the built server (real provider
calls, 62 checks including a same-session resilience phase):

```bash
npm run build
npm run verify
```

Optional environment variables (PowerShell):

```powershell
$env:SEMANTIC_SCHOLAR_API_KEY = "your_key"
$env:OPENALEX_API_KEY = "your_openalex_key"
$env:OPENALEX_MAILTO = "you@example.com"
$env:EUROPEPMC_EMAIL = "you@example.com"
$env:NCBI_EMAIL = "you@example.com"          # PubMed (E-utilities etiquette)
$env:CROSSREF_MAILTO = "you@example.com"     # Crossref polite pool
$env:LITERATURE_MCP_CACHE_TTL_MS = "300000"
$env:LITERATURE_MCP_DEADLINE_MS = "50000"    # total per-call budget
$env:LITERATURE_MCP_SOURCE_BUDGET_MS = "30000" # per-source paging budget
$env:LITERATURE_MCP_QUIET = "1"              # silence stderr diagnostics
```

Or with `bash`:

```bash
export SEMANTIC_SCHOLAR_API_KEY=your_key
export OPENALEX_API_KEY=your_openalex_key
export OPENALEX_MAILTO=you@example.com
export EUROPEPMC_EMAIL=you@example.com
export NCBI_EMAIL=you@example.com
export CROSSREF_MAILTO=you@example.com
export LITERATURE_MCP_CACHE_TTL_MS=300000
export LITERATURE_MCP_DEADLINE_MS=50000
export LITERATURE_MCP_SOURCE_BUDGET_MS=30000
```

Semantic Scholar works without a key, but a key usually improves rate limits.
`OPENALEX_API_KEY` is sent to OpenAlex as the `api_key` query parameter when configured.
`OPENALEX_MAILTO` opts into OpenAlex's faster "polite pool"; set it to a real contact email.
OpenAlex now requires a free key for cursor paging past the first page, so `OPENALEX_API_KEY` is effectively required for the automatic backfill; without it the first page still works and the report notes the 401.
`LITERATURE_MCP_CACHE_TTL_MS` controls the in-process GET response cache. The default is 300000 milliseconds; set it to `0` to disable caching.

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
  "queries": [
    "single cell multiomics tumor survival prediction",
    "cell-type resolved multi-omic integration prognosis"
  ],
  "yearFrom": 2020,
  "limit": 10,
  "sources": ["openalex", "europepmc", "semantic_scholar", "arxiv"],
  "includePreprints": true,
  "includeRetracted": false,
  "seedPapers": ["10.1038/s41588-021-00911-1"],
  "screeningCriteria": {
    "mustInclude": ["single-cell"],
    "prefer": ["multi-omics", "cancer prognosis", "survival prediction"],
    "exclude": ["review", "editorial", "protocol"],
    "minCitations": 5
  }
}
```

### Transparency fields in the result

- `sourceReports`: per-source coverage — `{source, status, available, retrieved, pages, queries, durationMs, note}`. `status` is the failure taxonomy (`ok` / `timeout` / `rate_limited` / `upstream_error` / `cancelled`), `queries` names the variants that source actually ran (Semantic Scholar runs only the primary topic), and a zero result after a successful query is `status: ok` with `retrieved: 0`.
- `rejectedBy`: aggregate rejection statistics, keyed by the ordered exclusion codes `year`, `min-citations`, `excluded-term`, `missing-must`, `preprint`, `below-relevance`.
- `seedReports`: per-seed calibration for the optional `seedPapers` parameter — `hit` (with merged ID and sources), `filtered` (with exclusion code), or `not-found`, telling apart retrieval-layer gaps from screening-layer gaps.
- `candidateLimit`: how many screened candidates the response may contain (defaults to `limit`). Set it above `limit` only when you need a wider net to judge yourself; `candidatesBeforeLimit` reports how many candidates passed screening before that cap was applied, so a truncated response is visible.
- `retrieval`: `{queries, terms}` — the variants actually sent to the providers and the union of terms used for screening, so a thin result set can be attributed to a narrow query rather than to the corpus.
- `timing`: `{elapsedMs, deadlineMs, expired}` — how much of the budget the call used and whether it returned partial results.
- `rejectedDetails` (with `explain: true`): one line per excluded candidate with the rule that fired and why.
- every returned paper carries `scoreBreakdown` — the exact per-factor contributions (`terms / must / prefer / cross / meta / cites / infl / recency`) that sum to its `score`.

### Query variants (why `queries` matters)

Provider retrieval is lexical, not semantic: a single query is ANDed word by word, so an
on-topic paper that words the concept differently is invisible no matter how it is ranked
afterwards. A real example: the topic `entropy production ecosystem thermodynamics` does
not retrieve *"Available energy fluxes drive a transition in the diversity, stability, and
functional structure of microbial communities"* — the paper never says "entropy", so the
AND fails at the provider. Adding the variant `energy flux microbial communities` returns
it immediately.

The server implements variants as **AND inside a variant, OR across variants**:

```
(entropy production ecosystem thermodynamics) OR (energy flux microbial communities)
```

and screens papers against the **union** of every variant's terms, so a paper found through
alternative vocabulary is not rejected for lacking the primary topic's words. Supply 3–5
variants for any non-trivial search: synonyms, subfield terms, and the wording a paper's
title would plausibly use. Semantic Scholar has no boolean query syntax, so it receives the
primary topic only.

When only one variant is sent and the candidate pool is thin, the response carries a
`Narrow retrieval` warning.

## Implementation Notes

Query behavior:

- Every provider query is built from the plan `(variant 1 terms) OR (variant 2 terms) …`, with the words inside each variant ANDed over its first 8 content tokens (`all:t1 AND all:t2` for arXiv, `(TITLE:"t1" OR ABSTRACT:"t1") AND …` for Europe PMC, `t1[tiab] AND t2[tiab]` for PubMed, implicit AND for OpenAlex). Semantic Scholar has no boolean syntax and receives only the primary variant; Crossref is a relevance query (the variants' words are pooled). arXiv error pseudo-entries surface as errors, and `opensearch:totalResults` is reported as `available`.
- PubMed (NCBI E-utilities) reports esearch `count` as `available` and leaves `citationCount` unknown (like arXiv); Crossref reports `is-referenced-by-count` and only fetches scholarly types (journal-article, proceedings, book-chapter, posted-content, …).

Reliability:

- **Deadline**: one call shares a single wall-clock budget (default 50s against the client's real 60s `toolCallTimeoutMs`), covering queueing, backoff, requests, response-body reads and paging. Per-attempt timeouts are capped by the remaining budget; a response body that stalls after the headers is bounded by the same timer.
- **Cancellation**: the MCP `notifications/cancelled` signal propagates through every layer (throttle queue, backoff sleeps, fetch, paging). A cancelled call stops issuing requests immediately and releases its queue slot.
- **Partial results**: each source has its own paging budget (default 30s). On deadline expiry the pages already fetched are kept, the source is marked `timeout`, and the response says `partial results returned` with a `timing` block.
- **Cooldowns**: a `Retry-After` longer than the remaining budget (or 15s) is not slept through — the source returns `rate_limited` at once and a shared per-scope cooldown is recorded; while it lasts, later calls fail fast instead of burning quota. Cooldowns are visible in `literature_mcp_health`.
- **Diagnostics**: structured JSON logs on stderr (`LITERATURE_MCP_QUIET=1` to silence), one line per request with the request id, source, page, queue wait, HTTP status, `Retry-After` and end reason. Error messages carry redacted URLs (origin + path only — query strings can contain API keys).
- **Build identity**: `literature_mcp_health` returns `buildId` (hash of the loaded `dist` modules), `pid`, uptime and node version before probing upstreams, so a GUI holding a stale stdio process is immediately visible. Upstream probes are concurrent with a 4s cap each. arXiv reports no citation counts (`citationCount` is `undefined`, not `0`), and unknown counts pass `minCitations` with an explicit note.
- OpenAlex searches `title_and_abstract.search` and pushes constraints server-side: year range, `cited_by_count:>N-1`, `is_retracted:false` (default; `includeRetracted: true` opts back in), and `type:article` when preprints are excluded. `meta.count` is reported as `available`, responses are field-limited via `select`, and `open_access.oa_url` is exposed as `oaUrl`.
- Europe PMC uses `resultType=core` with `cursorMark` pagination and indexes preprints (`SRC:"PPR"`) alongside journal articles. (The parameter is `cursorMark`; a plain `cursor` is silently ignored and would make every page return page 1 again.)
- Screening matches terms on token boundaries ("omics" never matches "economics", "graph" never matches "paragraph"), and without `mustInclude` terms a paper must match at least one term of the topic/variant union.
- Default exclusions (editorial, commentary, erratum, correction, letter to the editor) are suppressed when the topic itself contains the term: "quantum error correction" is a subject, not a correction notice. Caller-supplied `exclude` terms always apply — that is an explicit instruction, not a heuristic.
- A topic made only of stopwords or short tokens ("the of and") is rejected before any provider is queried; searching it would return an arbitrary slice of the index.
- Retries honor server `Retry-After` and keep a 3-second floor for arXiv; transport failures (timeouts, connection resets) are retried with the same backoff instead of dropping a source on the first blip. The response cache is keyed by the full header values (no cross-API-key collisions) and capped at 200 LRU entries.
- Provider `null` values are normalised away, so a returned paper can be passed straight back into `generate_research_ideas`, `review_research_idea`, or `export_to_zotero` without tripping input validation.
- Zotero imports report the real success count parsed from Zotero's `success`/`failed` response, with failed items listed for retry.

Scoring combines:

- query term overlap in title/abstract
- required and preferred phrases
- DOI/arXiv metadata quality
- cross-source confirmation
- citation counts
- recency

When screening returns fewer papers than the requested `limit`, sources are paged again in order (OpenAlex cursor / arXiv start / S2 offset) within hard caps (at most 2 extra pages per source, candidate pool at most 200/100 per source).

Intermediate candidate tables are intentionally not exposed as a workflow step.
