import type { Paper } from "../types.js";
import { fetchWithTimeout } from "../http.js";

interface ZoteroExportOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  papers: Paper[];
}

interface ZoteroCreator {
  creatorType: "author";
  firstName?: string;
  lastName: string;
}

interface ZoteroItem {
  itemType: "journalArticle" | "preprint";
  title: string;
  creators: ZoteroCreator[];
  abstractNote?: string;
  publicationTitle?: string;
  date?: string;
  DOI?: string;
  url?: string;
  archiveID?: string;
  extra?: string;
}

export async function exportToZotero(options: ZoteroExportOptions): Promise<{
  success: boolean;
  endpoint: string;
  imported: number;
  response: unknown;
}> {
  if (!options.userId && !options.groupId) {
    throw new Error("Provide either zoteroUserId or zoteroGroupId.");
  }

  const endpoint = options.userId
    ? `https://api.zotero.org/users/${encodeURIComponent(options.userId)}/items`
    : `https://api.zotero.org/groups/${encodeURIComponent(options.groupId ?? "")}/items`;

  const items = options.papers.map(toZoteroItem);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Zotero-API-Key": options.apiKey,
    },
    body: JSON.stringify(items),
  });

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Zotero may return plain text for some failures.
  }

  if (!response.ok) {
    throw new Error(`Zotero export failed: ${response.status} ${response.statusText} ${text}`);
  }

  return {
    success: true,
    endpoint,
    imported: items.length,
    response: parsed,
  };
}

function toZoteroItem(paper: Paper): ZoteroItem {
  const isPreprint = paper.sources.includes("arxiv") && !paper.doi;
  return {
    itemType: isPreprint ? "preprint" : "journalArticle",
    title: paper.title,
    creators: paper.authors.map(toCreator),
    abstractNote: paper.abstract,
    publicationTitle: isPreprint ? undefined : paper.venue,
    date: paper.publishedDate ?? (paper.year ? String(paper.year) : undefined),
    DOI: paper.doi,
    url: paper.url,
    archiveID: paper.arxivId ? `arXiv:${paper.arxivId}` : undefined,
    extra: [
      paper.openalexId ? `OpenAlex: ${paper.openalexId}` : undefined,
      paper.semanticScholarId ? `Semantic Scholar: ${paper.semanticScholarId}` : undefined,
      paper.sources.length > 0 ? `Sources: ${paper.sources.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function toCreator(name: string): ZoteroCreator {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { creatorType: "author", lastName: name };
  return {
    creatorType: "author",
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? name,
  };
}
