# Knowledge Graph Design

## Overview

Knowledge Graph layer over Apple Notes enabling relationship discovery, tag-based organization, and note linking.

## Goals

- Detect relationships between notes (tags, links, similarity)
- Search by relationships
- Export graph for visualization and Obsidian migration

## Relationship Types

### Explicit (user-created)

- `#tag` - hashtags in note content
- `[[Note Title]]` - wiki-style links to other notes

### Implicit (system-derived)

- Semantic similarity (embedding cosine similarity)
- Shared folder
- Temporal proximity

## Data Model

### Extended NoteRecord

```typescript
interface NoteRecord {
  // Existing fields
  id: string
  title: string
  folder: string
  content: string
  vector: number[]
  indexed_at: string

  // New fields for Knowledge Graph
  tags: string[]           // ["project", "idea"] - without #
  outlinks: string[]       // ["Meeting Notes", "Plan"]
  outlink_ids: string[]    // [resolved Apple Notes IDs]
}
```

### Metadata Extraction

```typescript
function extractMetadata(content: string): NoteMetadata {
  // Tags: #word or #multi-word-tag
  const tags = content.match(/#[\w-]+/g) || []

  // Wiki links: [[Note Title]]
  const outlinks = content.match(/\[\[([^\]]+)\]\]/g) || []

  return {
    tags: tags.map(t => t.slice(1).toLowerCase()),
    outlinks: outlinks.map(l => l.slice(2, -2))
  }
}
```

## New MCP Tools

### `related-notes`

Find connected notes by various criteria.

```typescript
// Input
{
  title: "My Note",
  types: ["tag", "link", "similar"],
  limit: 10
}

// Output
{
  results: [
    { title: "Meeting Notes", folder: "Work",
      relationship: "link", direction: "outgoing" },
    { title: "Another Idea", folder: "Ideas",
      relationship: "tag", shared_tags: ["project"] },
    { title: "Similar Topic", folder: "Work",
      relationship: "similar", score: 0.87 }
  ]
}
```

### `list-tags`

List all tags with occurrence counts.

```typescript
// Output
{
  tags: [
    { tag: "project", count: 15 },
    { tag: "idea", count: 8 },
    { tag: "todo", count: 23 }
  ]
}
```

### `search-by-tag`

Filter notes by tag.

```typescript
// Input
{ tag: "project", folder: "Work" }  // folder optional

// Output - same format as search-notes
```

### `export-graph`

Export knowledge graph to standard format.

```typescript
// Input
{
  format: "json" | "graphml" | "obsidian",
  folder?: "Work",
  include_similar: true,
  output_path?: "~/export"  // for obsidian format
}

// Output (JSON format)
{
  nodes: [
    { id: "x-coredata://...", label: "Note Title",
      folder: "Work", tags: ["project"] }
  ],
  edges: [
    { source: "id1", target: "id2",
      type: "link", weight: 1.0 }
  ]
}
```

## Export Formats

### JSON

Standard format for custom visualization, D3.js, web apps.

```json
{
  "nodes": [...],
  "edges": [...]
}
```

### GraphML

XML format for professional graph tools (Gephi, yEd, Cytoscape).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="folder" for="node" attr.name="folder" attr.type="string"/>
  <key id="type" for="edge" attr.name="type" attr.type="string"/>
  <graph id="G" edgedefault="directed">
    <node id="id1">
      <data key="label">Note Title</data>
      <data key="folder">Work</data>
    </node>
    <edge source="id1" target="id2">
      <data key="type">link</data>
    </edge>
  </graph>
</graphml>
```

### Obsidian (Full Export)

Creates Obsidian vault structure with:

1. **Folder hierarchy** - mirrors Apple Notes folders
2. **Markdown files** - converted content with preserved wiki-links
3. **Frontmatter metadata** - YAML with tags, dates, source ID

```markdown
---
tags:
  - project
  - idea
created: 2026-01-09T10:30:00Z
modified: 2026-01-09T15:45:00Z
source_id: x-coredata://ABC123
---

# Note Title

Content with [[wiki-links]] preserved...
```

4. **Attachments** - if accessible via JXA (best effort)

## Relationship Weights

| Type | Weight | Reason |
|------|--------|--------|
| `link` | 1.0 | Explicit user intent |
| `tag` | 0.8 | Strong thematic connection |
| `similar` | 0.5 x score | Derived similarity |

## Implementation Notes

### Indexing

- Extraction happens during `index-notes` and `reindex-note`
- `outlink_ids` resolved lazily at query time
- New fields are optional for backward compatibility

### Similar Notes Algorithm

```typescript
async function findSimilarNotes(noteId: string, limit: number) {
  const source = await db.getById(noteId)
  const similar = await db.vectorSearch(source.vector, limit + 1)
  return similar
    .filter(n => n.id !== noteId)
    .map(n => ({ ...n, relationship: "similar", score: n.score }))
}
```

### Combined `related-notes` Algorithm

```typescript
async function relatedNotes(noteId: string, types: RelationType[]) {
  const results: RelatedNote[] = []

  if (types.includes("link")) {
    results.push(...await findLinkedNotes(noteId))
  }
  if (types.includes("tag")) {
    results.push(...await findBySharedTags(noteId))
  }
  if (types.includes("similar")) {
    results.push(...await findSimilarNotes(noteId))
  }

  return dedupeAndRank(results)
}
```

## Scope

### v1.3.0 (this release)

- `#tag` parsing during indexing
- `[[wiki-link]]` parsing during indexing
- `related-notes` tool
- `list-tags` tool
- `search-by-tag` tool
- `export-graph` tool with all three formats:
  - JSON
  - GraphML
  - Obsidian (full vault export)

### Future (v2+)

- `@mention` parsing
- Bidirectional link index (backlinks)
- Browser-based graph visualization
- Real-time sync with Obsidian vault
