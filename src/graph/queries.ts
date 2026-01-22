/**
 * Knowledge graph query operations.
 */

import { getVectorStore } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";
import { NoteNotFoundError } from "../errors/index.js";
import { generatePreview } from "../search/index.js";
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_RELATED_NOTES_LIMIT,
  GRAPH_TAG_WEIGHT,
  GRAPH_LINK_WEIGHT,
  GRAPH_SIMILAR_WEIGHT,
} from "../config/constants.js";
import type { SearchResult } from "../types/index.js";

const debug = createDebugLogger("GRAPH");

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * List all tags with occurrence counts.
 * Sorted by count descending.
 */
export async function listTags(): Promise<TagCount[]> {
  debug("Listing all tags");

  const store = getVectorStore();
  const records = await store.getAll();

  // Aggregate tag counts
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const tag of record.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  // Sort by count descending
  const result = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  debug(`Found ${result.length} unique tags`);
  return result;
}

export interface SearchByTagOptions {
  folder?: string;
  limit?: number;
}

/**
 * Find notes with a specific tag.
 */
export async function searchByTag(
  tag: string,
  options: SearchByTagOptions = {}
): Promise<SearchResult[]> {
  const { folder, limit = DEFAULT_SEARCH_LIMIT } = options;

  debug(`Searching for tag: ${tag}`);

  const store = getVectorStore();
  const records = await store.getAll();

  // Filter by tag (case-insensitive)
  let matches = records.filter((r) =>
    (r.tags ?? []).includes(tag.toLowerCase())
  );

  // Filter by folder if specified
  if (folder) {
    const normalizedFolder = folder.toLowerCase();
    matches = matches.filter(
      (r) => r.folder.toLowerCase() === normalizedFolder
    );
  }

  // Transform to SearchResult and limit
  const results: SearchResult[] = matches.slice(0, limit).map((r, i) => ({
    id: r.id,
    title: r.title,
    folder: r.folder,
    preview: generatePreview(r.content),
    modified: r.modified,
    score: 1 / (1 + i),
  }));

  debug(`Found ${results.length} notes with tag: ${tag}`);
  return results;
}

export type RelationshipType = "tag" | "link" | "similar";

export interface RelatedNote {
  id: string;
  title: string;
  folder: string;
  relationship: RelationshipType;
  score: number;
  sharedTags?: string[];
  direction?: "outgoing" | "incoming";
}

export interface FindRelatedOptions {
  types?: RelationshipType[];
  limit?: number;
}

/**
 * Find notes related to a source note by tags, links, or semantic similarity.
 */
export async function findRelatedNotes(
  sourceId: string,
  options: FindRelatedOptions = {}
): Promise<RelatedNote[]> {
  const { types = ["tag", "link", "similar"], limit = DEFAULT_RELATED_NOTES_LIMIT } = options;

  debug(`Finding related notes for: ${sourceId}`);

  const store = getVectorStore();
  const allRecords = await store.getAll();

  // Find source note
  const source = allRecords.find((r) => r.id === sourceId);
  if (!source) {
    throw new NoteNotFoundError(sourceId);
  }

  const results: RelatedNote[] = [];
  const seen = new Set<string>();

  // Find by shared tags
  if (types.includes("tag") && source.tags?.length > 0) {
    for (const record of allRecords) {
      if (record.id === sourceId || seen.has(record.id)) continue;

      const shared = (record.tags ?? []).filter((t) => source.tags.includes(t));
      if (shared.length > 0) {
        results.push({
          id: record.id,
          title: record.title,
          folder: record.folder,
          relationship: "tag",
          score: GRAPH_TAG_WEIGHT * (shared.length / source.tags.length),
          sharedTags: shared,
        });
        seen.add(record.id);
      }
    }
  }

  // Find by outlinks (notes this note links to)
  if (types.includes("link")) {
    for (const linkTitle of source.outlinks ?? []) {
      // Skip null/undefined links
      if (!linkTitle) continue;

      const linked = allRecords.find(
        (r) =>
          r.title.toLowerCase() === linkTitle.toLowerCase() &&
          r.id !== sourceId &&
          !seen.has(r.id)
      );
      if (linked) {
        results.push({
          id: linked.id,
          title: linked.title,
          folder: linked.folder,
          relationship: "link",
          score: GRAPH_LINK_WEIGHT,
          direction: "outgoing",
        });
        seen.add(linked.id);
      }
    }

    // Find backlinks (notes that link to this note)
    for (const record of allRecords) {
      if (record.id === sourceId || seen.has(record.id)) continue;

      const linksToSource = (record.outlinks ?? []).some(
        (l) => l && l.toLowerCase() === source.title.toLowerCase()
      );
      if (linksToSource) {
        results.push({
          id: record.id,
          title: record.title,
          folder: record.folder,
          relationship: "link",
          score: GRAPH_LINK_WEIGHT,
          direction: "incoming",
        });
        seen.add(record.id);
      }
    }
  }

  // Find by semantic similarity
  if (types.includes("similar") && source.vector?.length > 0) {
    const similarResults = await store.search(source.vector, limit + 1);

    for (const similar of similarResults) {
      if (similar.id === sourceId || seen.has(similar.id ?? "")) continue;

      results.push({
        id: similar.id ?? "",
        title: similar.title,
        folder: similar.folder,
        relationship: "similar",
        score: GRAPH_SIMILAR_WEIGHT * similar.score,
      });
      seen.add(similar.id ?? "");
    }
  }

  // Sort by score and limit
  results.sort((a, b) => b.score - a.score);

  debug(`Found ${results.length} related notes`);
  return results.slice(0, limit);
}
