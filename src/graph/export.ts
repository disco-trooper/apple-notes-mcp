// src/graph/export.ts
/**
 * Knowledge graph export to various formats.
 */

import { getVectorStore } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";
import { GRAPH_LINK_WEIGHT, GRAPH_TAG_CLIQUE_MAX, GRAPH_TAG_WEIGHT } from "../config/constants.js";

const debug = createDebugLogger("EXPORT");

export type GraphFormat = "json" | "graphml";

export interface GraphNode {
  id: string;
  label: string;
  folder: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  /** `link` edges are directed (source links to target); `tag` edges are undirected. */
  type: "link" | "tag";
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExportOptions {
  format: GraphFormat;
  folder?: string;
}

/**
 * Export knowledge graph to specified format.
 */
export async function exportGraph(options: ExportOptions): Promise<GraphData | string> {
  const { format, folder } = options;

  debug(`Exporting graph in ${format} format`);

  const store = getVectorStore();
  let records = await store.getAllMetadata();

  // Filter by folder if specified
  if (folder) {
    const normalizedFolder = folder.toLowerCase();
    records = records.filter(r => r.folder.toLowerCase() === normalizedFolder);
  }

  // Build graph data
  const nodes: GraphNode[] = records.map(r => ({
    id: r.id,
    label: r.title,
    folder: r.folder,
    tags: r.tags ?? [],
  }));

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (type: GraphEdge["type"], source: string, target: string, weight: number): void => {
    if (source === target) return;
    // Tag edges are undirected: key them by the sorted pair. "\0" cannot occur in ids.
    const [a, b] = type === "tag" && target < source ? [target, source] : [source, target];
    const key = `${type}\0${a}\0${b}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target, type, weight });
  };

  // Link edges; duplicate titles resolve to the first note
  const byTitle = new Map<string, string>();
  for (const record of records) {
    const key = record.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, record.id);
  }
  for (const record of records) {
    for (const linkTitle of record.outlinks ?? []) {
      if (!linkTitle) continue;
      const targetId = byTitle.get(linkTitle.toLowerCase());
      if (targetId) addEdge("link", record.id, targetId, GRAPH_LINK_WEIGHT);
    }
  }

  // Tag edges (notes sharing a tag)
  const tagGroups = new Map<string, string[]>();
  for (const record of records) {
    for (const tag of record.tags ?? []) {
      const group = tagGroups.get(tag);
      if (group) group.push(record.id);
      else tagGroups.set(tag, [record.id]);
    }
  }

  for (const noteIds of tagGroups.values()) {
    if (noteIds.length > GRAPH_TAG_CLIQUE_MAX) {
      // Large groups: star around the first note instead of O(n²) pairs
      for (let i = 1; i < noteIds.length; i++) {
        addEdge("tag", noteIds[0], noteIds[i], GRAPH_TAG_WEIGHT);
      }
      continue;
    }
    for (let i = 0; i < noteIds.length; i++) {
      for (let j = i + 1; j < noteIds.length; j++) {
        addEdge("tag", noteIds[i], noteIds[j], GRAPH_TAG_WEIGHT);
      }
    }
  }

  const graphData: GraphData = { nodes, edges };

  if (format === "json") {
    return graphData;
  }

  if (format === "graphml") {
    return toGraphML(graphData);
  }

  throw new Error(`Unknown format: ${format}`);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toGraphML(data: GraphData): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="folder" for="node" attr.name="folder" attr.type="string"/>',
    '  <key id="tags" for="node" attr.name="tags" attr.type="string"/>',
    '  <key id="type" for="edge" attr.name="type" attr.type="string"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <graph id="G" edgedefault="directed">',
  ];

  for (const node of data.nodes) {
    lines.push(`    <node id="${escapeXml(node.id)}">`);
    lines.push(`      <data key="label">${escapeXml(node.label)}</data>`);
    lines.push(`      <data key="folder">${escapeXml(node.folder)}</data>`);
    lines.push(`      <data key="tags">${escapeXml(node.tags.join(","))}</data>`);
    lines.push("    </node>");
  }

  for (const edge of data.edges) {
    const directed = edge.type === "tag" ? ' directed="false"' : "";
    lines.push(`    <edge source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}"${directed}>`);
    lines.push(`      <data key="type">${edge.type}</data>`);
    lines.push(`      <data key="weight">${edge.weight}</data>`);
    lines.push("    </edge>");
  }

  lines.push("  </graph>");
  lines.push("</graphml>");

  return lines.join("\n");
}
