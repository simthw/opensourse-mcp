import { sanitizeTopic, searchTerms } from "./utils.js";

/**
 * A search is a *set* of query variants, not one string.
 *
 * Lexical provider search (OpenAlex / Europe PMC / arXiv) ANDs the words of a
 * single query, so a paper that describes the same concept with different
 * vocabulary is invisible at retrieval time — e.g. "entropy production in
 * ecosystems" never returns "available energy fluxes drive a transition in
 * microbial communities", even though the latter is exactly on topic.
 *
 * The plan fixes that by ORing the variants at the provider while ANDing the
 * words inside each variant:
 *
 *   (entropy production ecosystems) OR (energy flux microbial communities)
 *
 * Screening then accepts a paper that matches the terms of ANY variant, so
 * relevance is judged over the whole concept rather than the primary phrasing.
 */
export interface QueryPlan {
  /** Sanitised, de-duplicated variants; the primary topic always comes first. */
  variants: string[];
  /** Union of the variants' content terms, used as the screening vocabulary. */
  terms: string[];
}

const MAX_VARIANTS = 6;
const MAX_TERMS = 24;

export function buildQueryPlan(topic: string, extraQueries: string[] = []): QueryPlan {
  const variants: string[] = [];
  const seen = new Set<string>();

  for (const raw of [topic, ...extraQueries]) {
    const cleaned = sanitizeTopic(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    // A variant with no content words adds neither retrieval nor screening
    // value, so drop it instead of sending a meaningless AND group upstream.
    if (searchTerms(cleaned).length === 0) continue;
    seen.add(key);
    variants.push(cleaned);
    if (variants.length >= MAX_VARIANTS) break;
  }

  if (variants.length === 0) variants.push(sanitizeTopic(topic));

  const terms: string[] = [];
  for (const variant of variants) {
    for (const term of searchTerms(variant)) {
      if (terms.includes(term)) continue;
      terms.push(term);
      if (terms.length >= MAX_TERMS) break;
    }
    if (terms.length >= MAX_TERMS) break;
  }

  return { variants, terms };
}

/**
 * Token groups for provider query builders: one group per variant, each group
 * ANDed internally and ORed with the others by the provider.
 */
export function variantGroups(topic: string, variants?: string[], maxTokens = 8): string[][] {
  const list = variants?.length ? variants : [topic];
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const variant of list) {
    const tokens = searchTerms(sanitizeTopic(variant), maxTokens);
    if (tokens.length === 0) continue;
    const key = tokens.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(tokens);
  }
  return groups;
}
