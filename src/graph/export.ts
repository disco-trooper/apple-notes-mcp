// src/graph/export.ts
/**
 * Knowledge graph export to various formats.
 */

import { getVectorStore } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";
import { GRAPH_LINK_WEIGHT, GRAPH_TAG_WEIGHT } from "../config/constants.js";

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
  type: "link" | "tag" | "similar";
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
  let records = await store.getAll();

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
  const nodeIds = new Set(records.map(r => r.id));

  // Add link edges
  for (const record of records) {
    for (const linkTitle of record.outlinks ?? []) {
      // Skip null/undefined links
      if (!linkTitle) continue;

      const target = records.find(r => r.title.toLowerCase() === linkTitle.toLowerCase());
      if (target && nodeIds.has(target.id)) {
        edges.push({
          source: record.id,
          target: target.id,
          type: "link",
          weight: GRAPH_LINK_WEIGHT,
        });
      }
    }
  }

  // Add tag edges (notes sharing same tag)
  const tagGroups = new Map<string, string[]>();
  for (const record of records) {
    for (const tag of record.tags ?? []) {
      if (!tagGroups.has(tag)) {
        tagGroups.set(tag, []);
      }
      tagGroups.get(tag)!.push(record.id);
    }
  }

  const seenTagEdges = new Set<string>();
  for (const [, noteIds] of tagGroups) {
    if (noteIds.length < 2) continue;
    for (let i = 0; i < noteIds.length; i++) {
      for (let j = i + 1; j < noteIds.length; j++) {
        const edgeKey = [noteIds[i], noteIds[j]].sort().join("-");
        if (seenTagEdges.has(edgeKey)) continue;
        seenTagEdges.add(edgeKey);
        edges.push({
          source: noteIds[i],
          target: noteIds[j],
          type: "tag",
          weight: GRAPH_TAG_WEIGHT,
        });
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
    lines.push(`    <edge source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">`);
    lines.push(`      <data key="type">${edge.type}</data>`);
    lines.push(`      <data key="weight">${edge.weight}</data>`);
    lines.push("    </edge>");
  }

  lines.push("  </graph>");
  lines.push("</graphml>");

  return lines.join("\n");
}
