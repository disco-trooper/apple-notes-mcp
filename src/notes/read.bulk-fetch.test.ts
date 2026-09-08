/**
 * Bulk-fetch regression tests for Apple Notes JXA reads (issue #8).
 *
 * WHY THESE TESTS ASSERT ON THE GENERATED JXA SOURCE INSTEAD OF RESULTS:
 * The 1.8.2 implementation read every note through per-note property access
 * (`note.properties()`, `note.body()`, `note.id()` inside one giant JXA
 * script), which blows up on large libraries (single-call OOM / timeout with
 * no resumption). The fix fetches notes in bounded batches driven by
 * `.slice(...)` plus plural JXA getters. A result-only assertion such as
 * "returns 5 notes" passes on BOTH implementations whenever the JXA layer is
 * The assertions below therefore pin the batched strategy itself: `.slice(`
 * must appear in the batched JXA, and metadata must come from plural bulk
 * getters (`notes.id()`/`name()`/...) with no per-note `note.properties()`
 * or `notes[i].*()` metadata reads (a singular body read survives only as a
 * degraded `catch` fallback when the bulk bodies getter fails).
 * Only `./jxa-runner.js` is mocked here. Note conversion (`htmlToMarkdown`) runs for
 * real, so the content assertions exercise the genuine mapping code path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the killable JXA runner before importing the read module (same pattern
// as read.test.ts). read.ts no longer imports run-jxa.
vi.mock("./jxa-runner.js", () => ({
  runJxaWithKill: vi.fn(),
}));

import { runJxaWithKill } from "./jxa-runner.js";
import { fetchFolderBatched, getAllNotesWithFallback } from "./read.js";
import {
  DEFAULT_JXA_TIMEOUT_MS,
  DEFAULT_NOTES_FETCH_BATCH_SIZE,
  getJxaTimeoutMs,
  getNotesFetchBatchSize,
} from "../config/constants.js";

interface RawNote {
  id: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  htmlContent: string;
}

function makeRawNotes(count: number): RawNote[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    title: `Note ${i}`,
    folder: i % 2 === 0 ? "Work" : "Personal",
    created: "2024-01-01T00:00:00Z",
    modified: "2024-01-02T00:00:00Z",
    htmlContent: `<p>Content ${i}</p>`,
  }));
}

function jxaCallSources(): string[] {
  return vi.mocked(runJxaWithKill).mock.calls.map((args) => String(args[0]));
}

/**
 * Route mocked JXA calls by code string, mirroring the real bulk-fetch
 * protocol in read.ts (per-index fetch via getAllNotesWithContent):
 * - folder enumeration (`folders.name()`) resolves with a single-folder
 *   library (`{ names, counts }`), so batch ranges stay global and the
 *   batchSize / failStart expectations below keep single-folder semantics;
 * - count call (`.notes.length`, no `.slice(`, no `folders.name()`)
 *   resolves with the library size (fallback path when enumerate counts are
 *   missing/corrupt);
 * - batch call (contains `.slice(`) resolves with that JSON slice. Bounds
 *   live in the `const startIdx/endIdx` declarations, not in literal
 *   `.slice(2, 4)` args, so they are parsed from there. The generated JXA
 *   slices `slice(startIdx, endIdx - 1)` (inclusive JXA semantics mapping
 *   the exclusive JS range), while the mock applies plain JS `slice(start,
 *   end)` — both yield the same elements;
 * - array-returning title lookup (`foundNotes`) resolves with matches;
 * - single-note retry by title (`whose(`) or by index (`targetIdx`)
 *   resolves with that note object (or null when unknown). The by-index
 *   check runs before the count check because its bounds guard also reads
 *   `.notes.length`.
 * `failStart` makes the batch starting at that offset reject persistently,
 * including its metadata-recovery batch and per-note retries (tracked via
 * failedRanges), to simulate an unreadable range.
 */
function mockBulkFetch(allRaw: RawNote[], opts?: { failStart?: number }) {
  const failedRanges: Array<{ start: number; end: number }> = [];
  vi.mocked(runJxaWithKill).mockReset();
  vi.mocked(runJxaWithKill).mockImplementation(async (...args: Parameters<typeof runJxaWithKill>) => {
    const src = String(args[0]);
    if (src.includes("folders.name()")) {
      return JSON.stringify({ names: ["Work"], counts: [allRaw.length] });
    }
    if (src.includes(".slice(")) {
      const start = Number(src.match(/const startIdx = (\d+);/)?.[1]);
      const end = Number(src.match(/const endIdx = (\d+);/)?.[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error("mockBulkFetch: cannot parse batch bounds from JXA code");
      }
      if (opts?.failStart !== undefined && start === opts.failStart) {
        failedRanges.push({ start, end });
        throw new Error(`Simulated batch failure at offset ${start}`);
      }
      return JSON.stringify(allRaw.slice(start, end));
    }
    const titleMatch = src.match(/const targetTitle = ("(?:[^"\\]|\\.)*");/);
    if (titleMatch && src.includes("foundNotes")) {
      const title = JSON.parse(titleMatch[1]) as string;
      return JSON.stringify(allRaw.filter((n) => n.title === title));
    }
    if (src.includes("whose({ name:") || titleMatch) {
      const title = titleMatch ? (JSON.parse(titleMatch[1]) as string) : undefined;
      const index = allRaw.findIndex((n) => n.title === title);
      if (index >= 0 && failedRanges.some(({ start, end }) => index >= start && index < end)) {
        throw new Error(`Simulated retry failure for note "${title ?? ""}"`);
      }
      return JSON.stringify(index >= 0 ? allRaw[index] : null);
    }
    const indexMatch = src.match(/const targetIdx = (\d+);/);
    if (indexMatch) {
      const index = Number(indexMatch[1]);
      if (failedRanges.some(({ start, end }) => index >= start && index < end)) {
        throw new Error(`Simulated retry failure at index ${index}`);
      }
      return JSON.stringify(allRaw[index] ?? null);
    }
    if (src.includes(".notes.length")) {
      return JSON.stringify(allRaw.length);
    }
    throw new Error(`mockBulkFetch: unexpected JXA call: ${src.slice(0, 160)}`);
  });
}

describe("bulk fetch JXA strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("batches reads with .slice(", async () => {
    mockBulkFetch(makeRawNotes(5));
    await getAllNotesWithFallback({ batchSize: 2 });
    const sources = jxaCallSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.includes(".slice("))).toBe(true);
  });

  it("never uses per-note property access in the bulk path", async () => {
    mockBulkFetch(makeRawNotes(5));
    await getAllNotesWithFallback({ batchSize: 2 });
    const sources = jxaCallSources();
    const batches = sources.filter((s) => s.includes(".slice("));
    expect(batches.length).toBeGreaterThan(0);
    // The 1.8.2 regression pattern (singular property reads) is gone: no
    // `.properties()` anywhere in the batched JXA ...
    expect(batches.some((s) => s.includes(".properties()"))).toBe(false);
    // ... and no per-note metadata accessors either. Metadata comes from
    // plural bulk getters, which must be present.
    const perNoteMetadata = /notes\[i\]\s*\.\s*(properties|id|name|creationDate|modificationDate)\(\)/;
    expect(batches.some((s) => perNoteMetadata.test(s))).toBe(false);
    expect(batches.some((s) => s.includes("notes.id()"))).toBe(true);
    expect(batches.some((s) => s.includes("notes.name()"))).toBe(true);
    expect(batches.some((s) => s.includes("notes.body()"))).toBe(true);
    // A singular `notes[i].body()` survives only as a degraded fallback
    // inside `catch` (bulk `notes.body()` failed), never as the read
    // mechanism itself.
    for (const s of batches) {
      const fallbackAt = s.indexOf("notes[i].body()");
      if (fallbackAt !== -1) {
        expect(s.indexOf("catch")).toBeLessThan(fallbackAt);
      }
    }
  });

  it("fetches 5 notes with batchSize 2 via multiple JXA calls", async () => {
    mockBulkFetch(makeRawNotes(5));
    const result = await getAllNotesWithFallback({ batchSize: 2 });
    expect(vi.mocked(runJxaWithKill).mock.calls.length).toBeGreaterThan(2);
    expect(result.notes).toHaveLength(5);
    expect(result.notes.map((n) => n.title)).toEqual(
      expect.arrayContaining(["Note 0", "Note 1", "Note 2", "Note 3", "Note 4"]),
    );
    // htmlToMarkdown runs unmocked: converted content must come through.
    expect(result.notes[0].content).toContain("Content");
  });

  it("survives a failing batch: other batches still resolve", async () => {
    mockBulkFetch(makeRawNotes(5), { failStart: 2 });
    const result = await getAllNotesWithFallback({ batchSize: 2 });
    expect(result.notes).toHaveLength(3);
    const titles = result.notes.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["Note 0", "Note 1", "Note 4"]));
    expect(titles).not.toContain("Note 2");
    expect(titles).not.toContain("Note 3");
    expect(Array.isArray(result.skipped)).toBe(true);
  });

  it("plans batch ranges from enumerate counts without per-folder count calls", async () => {
    mockBulkFetch(makeRawNotes(5));
    const result = await getAllNotesWithFallback({ batchSize: 2 });
    expect(result.notes).toHaveLength(5);
    // Happy path: 1 enumerate call plus batch calls, zero standalone count
    // calls (`.notes.length` outside the enumeration script and outside
    // single-note retry guards).
    const countCalls = jxaCallSources().filter(
      (s) => s.includes(".notes.length") && !s.includes("folders.name()") && !s.includes("targetIdx")
    );
    expect(countCalls).toHaveLength(0);
  });

  it("falls back to per-folder count calls when enumerate counts are missing", async () => {
    const allRaw = makeRawNotes(5);
    vi.mocked(runJxaWithKill).mockReset();
    vi.mocked(runJxaWithKill).mockImplementation(async (...args: Parameters<typeof runJxaWithKill>) => {
      const src = String(args[0]);
      if (src.includes("folders.name()")) {
        // Corrupt enumerate: legacy shape without per-folder counts.
        return JSON.stringify({ names: ["Work"], count: 1 });
      }
      if (src.includes(".slice(")) {
        const start = Number(src.match(/const startIdx = (\d+);/)?.[1]);
        const end = Number(src.match(/const endIdx = (\d+);/)?.[1]);
        return JSON.stringify(allRaw.slice(start, end));
      }
      if (src.includes(".notes.length")) {
        return JSON.stringify(allRaw.length);
      }
      throw new Error(`unexpected JXA call: ${src.slice(0, 160)}`);
    });
    const result = await getAllNotesWithFallback({ batchSize: 2 });
    expect(result.notes).toHaveLength(5);
    const countCalls = jxaCallSources().filter(
      (s) => s.includes(".notes.length") && !s.includes("folders.name()") && !s.includes("targetIdx")
    );
    expect(countCalls.length).toBeGreaterThan(0);
  });
});

describe("mid-fetch folder-list shift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function folderRaw(folder: string, titles: string[]): RawNote[] {
    return titles.map((title, i) => ({
      id: `${folder}-${i}`,
      title,
      folder,
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-02T00:00:00Z",
      htmlContent: `<p>${folder} ${title}</p>`,
    }));
  }

  /**
   * Emulate Apple Notes across a mid-fetch folder-list change (issue #8
   * follow-up: a folder created/deleted mid-fetch shifts `app.folders()`,
   * so the driver's stale enumeration index points elsewhere). Notes live
   * keyed by folder NAME; every call is resolved against the folder list
   * current at its logical clock — the first `shiftAfterCalls` calls see
   * `initialNames`, later calls see `shiftedNames`. Batch/count calls parse
   * `const folderIndex` + `const expectedName` from the generated JXA and
   * enforce the real guard: an out-of-range index or a name mismatch
   * rejects with a `[FOLDER_MISMATCH]` error, anything else resolves the
   * addressed folder's notes. Single-note retries resolve against the same
   * clock (null on guard failure, mirroring their JXA).
   */
  function mockShiftingFolderList(args: {
    notesByFolder: Map<string, RawNote[]>;
    initialNames: string[];
    shiftedNames: string[];
    shiftAfterCalls: number;
  }): void {
    let callsSeen = 0;
    vi.mocked(runJxaWithKill).mockReset();
    vi.mocked(runJxaWithKill).mockImplementation(async (...callArgs: Parameters<typeof runJxaWithKill>) => {
      const src = String(callArgs[0]);
      const names = callsSeen >= args.shiftAfterCalls ? args.shiftedNames : args.initialNames;
      callsSeen++;
      if (src.includes("folders.name()")) {
        return JSON.stringify({
          names,
          counts: names.map((n) => args.notesByFolder.get(n)?.length ?? 0),
        });
      }
      const folderIndex = Number(src.match(/const folderIndex = (\d+);/)?.[1]);
      const expectedName = JSON.parse(
        src.match(/const expectedName = ("(?:[^"\\]|\\.)*");/)?.[1] ?? "null",
      ) as string | null;
      const guardedFolder = (): RawNote[] | null => {
        if (!Number.isInteger(folderIndex) || typeof expectedName !== "string") {
          throw new Error("mockShiftingFolderList: cannot parse folder address from JXA code");
        }
        if (folderIndex < 0 || folderIndex >= names.length) {
          throw new Error(
            `[FOLDER_MISMATCH] Folder at index ${folderIndex} is missing (expected ${expectedName})`,
          );
        }
        if (names[folderIndex] !== expectedName) {
          throw new Error(
            `[FOLDER_MISMATCH] Folder mismatch at index ${folderIndex}: expected ${expectedName} but found ${names[folderIndex]}`,
          );
        }
        return args.notesByFolder.get(expectedName) ?? [];
      };
      if (src.includes(".slice(")) {
        const start = Number(src.match(/const startIdx = (\d+);/)?.[1]);
        const end = Number(src.match(/const endIdx = (\d+);/)?.[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) {
          throw new Error("mockShiftingFolderList: cannot parse batch bounds from JXA code");
        }
        return JSON.stringify((guardedFolder() ?? []).slice(start, end));
      }
      if (src.includes("targetTitle")) {
        const title = JSON.parse(src.match(/const targetTitle = ("(?:[^"\\]|\\.)*");/)?.[1] ?? "null") as string | null;
        const folderNotes = guardedFolder();
        return JSON.stringify(folderNotes?.find((n) => n.title === title) ?? null);
      }
      if (src.includes("targetIdx")) {
        const index = Number(src.match(/const targetIdx = (\d+);/)?.[1]);
        const folderNotes = guardedFolder();
        return JSON.stringify(folderNotes?.[index] ?? null);
      }
      if (src.includes(".notes.length")) {
        return JSON.stringify((guardedFolder() ?? []).length);
      }
      throw new Error(`mockShiftingFolderList: unexpected JXA call: ${src.slice(0, 160)}`);
    });
  }

  it("remaps the index when a folder is inserted mid-fetch: one re-enumeration, no skips", async () => {
    const notesByFolder = new Map<string, RawNote[]>([
      ["Work", folderRaw("Work", ["W0", "W1"])],
      ["Target", folderRaw("Target", ["T0", "T1"])],
    ]);
    mockShiftingFolderList({
      notesByFolder,
      initialNames: ["Work", "Target"],
      shiftedNames: ["New", "Work", "Target"],
      // The "New" folder appears after the initial enumeration plus the
      // Work batch: only Target's stale index mismatches.
      shiftAfterCalls: 2,
    });
    const result = await getAllNotesWithFallback({ batchSize: 2 });
    expect(result.notes).toHaveLength(4);
    expect(result.notes.map((n) => n.title).sort()).toEqual(["T0", "T1", "W0", "W1"]);
    expect(result.skipped).toEqual([]);
    // One re-enumeration plus a retry — not one failure per batch.
    expect(jxaCallSources().filter((s) => s.includes("folders.name()"))).toHaveLength(2);
  });

  it("records one skip when a folder is deleted mid-fetch and the rest still resolves", async () => {
    const notesByFolder = new Map<string, RawNote[]>([
      ["Work", folderRaw("Work", ["W0", "W1"])],
      ["Doomed", folderRaw("Doomed", ["D0"])],
    ]);
    // The driver enumerates ["Work", "Doomed"], then "Doomed" vanishes:
    // its stale index no longer resolves even after re-enumeration.
    mockShiftingFolderList({
      notesByFolder,
      initialNames: ["Work", "Doomed"],
      shiftedNames: ["Work"],
      shiftAfterCalls: 1,
    });
    // fetchFolderBatched is the seam returning the skip channel (the
    // all-notes fast path drops per-folder skips by design).
    const deleted = await fetchFolderBatched("Doomed", { batchSize: 2 });
    expect(deleted.notes).toHaveLength(0);
    expect(deleted.skipped).toEqual(["Doomed"]);

    mockShiftingFolderList({
      notesByFolder,
      initialNames: ["Work", "Doomed"],
      shiftedNames: ["Work"],
      shiftAfterCalls: 1,
    });
    const survivor = await fetchFolderBatched("Work", { batchSize: 2 });
    expect(survivor.notes.map((n) => n.title).sort()).toEqual(["W0", "W1"]);
    expect(survivor.skipped).toEqual([]);
  });
});

describe("notes fetch batch size from environment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the new defaults", () => {
    expect(DEFAULT_NOTES_FETCH_BATCH_SIZE).toBe(100);
    expect(DEFAULT_JXA_TIMEOUT_MS).toBe(120000);
  });

  it.each(["abc", "0", "-5"])(
    "invalid NOTES_FETCH_BATCH_SIZE=%s falls back to default without crashing",
    async (value) => {
      vi.stubEnv("NOTES_FETCH_BATCH_SIZE", value);
      expect(getNotesFetchBatchSize()).toBe(DEFAULT_NOTES_FETCH_BATCH_SIZE);
      mockBulkFetch(makeRawNotes(3));
      const result = await getAllNotesWithFallback();
      expect(result.notes).toHaveLength(3);
    },
  );

  it("valid NOTES_FETCH_BATCH_SIZE is honored", () => {
    vi.stubEnv("NOTES_FETCH_BATCH_SIZE", "7");
    expect(getNotesFetchBatchSize()).toBe(7);
  });

  it("JXA timeout ignores invalid env", () => {
    vi.stubEnv("JXA_TIMEOUT_MS", "abc");
    expect(getJxaTimeoutMs()).toBe(DEFAULT_JXA_TIMEOUT_MS);
  });
});
