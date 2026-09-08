/**
 * Apple Notes read operations using JXA (JavaScript for Automation)
 *
 * This module provides functions to read notes, folders, and note metadata
 * from Apple Notes using macOS automation.
 */

import { runJxaWithKill } from "./jxa-runner.js";
import { createDebugLogger } from "../utils/debug.js";
import { htmlToMarkdown } from "./conversion.js";
import { getJxaTimeoutMs, getNotesFetchBatchSize } from "../config/constants.js";
import { IndexCancelledError } from "../indexing/contracts.js";

// Re-export for backwards compatibility
export { resolveNoteTitle, type ResolvedNote } from "./resolve.js";

// Debug logging
const debug = createDebugLogger("NOTES");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NoteInfo {
  /** Note title */
  title: string;
  /** Folder name containing the note */
  folder: string;
  /** Creation date as ISO string */
  created: string;
  /** Last modification date as ISO string */
  modified: string;
}

export interface NoteDetails extends NoteInfo {
  /** Note content as Markdown */
  content: string;
  /** Original HTML content from Apple Notes */
  htmlContent: string;
  /** Note ID for internal reference */
  id: string;
}

/** Options for an individual JXA execution: cancellation and timeout. */
export interface JxaFetchOptions {
  /** AbortSignal used to cancel a running fetch. */
  signal?: AbortSignal;
  /** Per-call timeout in milliseconds. Defaults to getJxaTimeoutMs(). */
  timeoutMs?: number;
}

/** Options for batched folder fetches. */
export interface BulkFetchOptions extends JxaFetchOptions {
  /** Notes per JXA batch. Defaults to getNotesFetchBatchSize(). */
  batchSize?: number;
  /** Called with the cumulative number of notes fetched so far. */
  onBatch?: (fetched: number) => void;
}

// -----------------------------------------------------------------------------
// Internal types and helpers
// -----------------------------------------------------------------------------

/** Raw note data from JXA before markdown conversion */
interface RawNoteData {
  id: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  htmlContent: string;
}

/**
 * Execute JXA code safely with error handling, timeout and cancellation.
 *
 * Runs through runJxaWithKill, which passes the timeout (default
 * getJxaTimeoutMs()) and the optional AbortSignal straight to the spawned
 * `osascript` child, so a timeout or abort truly kills the child instead of
 * merely abandoning the wait. On timeout the promise rejects with an
 * Error containing "timed out" plus a hint to lower
 * NOTES_FETCH_BATCH_SIZE; on abort (including an already-aborted signal
 * passed in) it rejects with IndexCancelledError.
 */
export async function executeJxa<T>(code: string, opts?: JxaFetchOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? getJxaTimeoutMs();
  const signal = opts?.signal;

  if (signal?.aborted) {
    throw new IndexCancelledError("JXA execution cancelled before start");
  }

  try {
    const result = await runJxaWithKill(code, { timeoutMs, signal });
    return result as unknown as T;
  } catch (error) {
    if (error instanceof IndexCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (signal?.aborted || message.includes("cancelled")) {
      throw new IndexCancelledError("JXA execution cancelled");
    }
    if (message.includes("timed out")) {
      throw error instanceof Error ? error : new Error(message);
    }
    debug("JXA execution error:", error);
    throw new Error(`JXA execution failed: ${message}`);
  }
}

/**
 * Convert raw JXA note data to NoteDetails with markdown content
 */
function toNoteDetails(raw: RawNoteData): NoteDetails {
  return {
    id: raw.id,
    title: raw.title,
    folder: raw.folder,
    created: raw.created,
    modified: raw.modified,
    content: htmlToMarkdown(raw.htmlContent),
    htmlContent: raw.htmlContent,
  };
}

/**
 * Normalize one parsed JXA payload item into RawNoteData shape.
 * Missing fields become empty strings. Nothing is filtered out here —
 * deciding what to skip or index is the indexer's job.
 */
function normalizeRawNoteData(item: unknown, folderName: string): RawNoteData {
  const record = (item ?? {}) as Partial<RawNoteData>;
  return {
    id: record.id ?? "",
    title: record.title ?? "",
    folder: record.folder ?? folderName,
    created: record.created ?? "",
    modified: record.modified ?? "",
    htmlContent: record.htmlContent ?? "",
  };
}

/**
 * Build JXA that enumerates all folders with per-folder note counts in one
 * call (as JSON `{ names, counts }`, parallel arrays). Counts come from
 * per-folder `notes.length` in the same script, so the driver can plan
 * batch ranges without a count call per folder. A folder whose count cannot
 * be read contributes 0 instead of failing the whole enumeration. Contains
 * `folders.name()` so folder-enumeration calls stay distinguishable from
 * count/batch calls.
 */
function buildFolderEnumerateJxa(): string {
  return `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const rawNames = app.folders.name();
    const names = (typeof rawNames === 'string') ? [rawNames] : (rawNames ? rawNames : []);
    const folderObjs = app.folders();
    const counts = [];
    for (let i = 0; i < names.length; i++) {
      try {
        const c = folderObjs[i].notes.length;
        counts.push((typeof c === 'number' && isFinite(c) && c >= 0) ? Math.floor(c) : 0);
      } catch (folderCountErr) {
        counts.push(0);
      }
    }

    return JSON.stringify({ names: names, counts: counts });
  `;
}

/**
 * Build JXA that returns only the note count of one folder (as a JSON
 * number). Fallback path for when the folder enumeration carried no usable
 * per-folder counts — the happy path plans batch ranges from the enumerate
 * counts and never runs this. The folder is addressed by its
 * enumeration index — never by name lookup, which would silently resolve to
 * the first match when duplicate folder names exist. Deliberately contains
 * no `.slice(` so count calls stay distinguishable from batch calls.
 *
 * @param folderIndex - Index into the most recent folder enumeration
 * @param expectedName - Folder name expected at that index; a mismatch
 * throws so a folder list that changed mid-fetch fails loudly
 * @param caseInsensitive - When true, the guard folds case (metadata path
 * restores the pre-bulk-fetch behavior); exact-match callers keep the
 * default strict comparison.
 */
function buildFolderCountJxa(
  folderIndex: number,
  expectedName: string,
  caseInsensitive = false
): string {
  const escapedExpected = JSON.stringify(expectedName);
  const nameGuard = caseInsensitive
    ? `actual.toLowerCase() !== expectedName.toLowerCase()`
    : `actual !== expectedName`;

  return `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const folderIndex = ${folderIndex};
    const expectedName = ${escapedExpected};

    const folder = app.folders()[folderIndex];
    if (!folder) {
      throw new Error('[FOLDER_MISMATCH] Folder at index ' + folderIndex + ' is missing (expected ' + expectedName + ')');
    }
    const actual = folder.name();
    if (${nameGuard}) {
      throw new Error('[FOLDER_MISMATCH] Folder mismatch at index ' + folderIndex + ': expected ' + expectedName + ' but found ' + actual);
    }

    return JSON.stringify(folder.notes.length);
  `;
}

/**
 * Build JXA that fetches one slice [start, end) of a folder's notes using
 * bulk (plural) getters instead of per-note property access.
 *
 * The folder is addressed by its enumeration index (see
 * buildFolderCountJxa), then sliced on the specifier itself:
 * `folder.notes.slice(start, end - 1)` — JXA slice is inclusive on both
 * ends, so the exclusive JS end maps to `end - 1` and `end > start` is
 * required. Metadata comes from arrays
 * (notes.id()/name()/creationDate()/modificationDate()) plus a bulk bodies
 * attempt (notes.body() with per-note fallback). Array lengths are
 * validated against each other and throw on mismatch; missing dates and
 * bodies become '' per element. The folder field always carries the actual
 * Notes folder name (original casing). Returns JSON.stringify of a
 * RawNoteData array.
 *
 * @param folderIndex - Index into the most recent folder enumeration
 * @param expectedName - Folder name expected at that index (see above)
 * @param start - Start index (inclusive)
 * @param end - End index (exclusive, must be greater than start)
 * @param includeBody - When false, bodies are skipped (metadata-only batches)
 * @param caseInsensitive - When true, match the folder case-insensitively
 */
export function buildFolderBatchJxa(
  folderIndex: number,
  expectedName: string,
  start: number,
  end: number,
  includeBody = true,
  caseInsensitive = false
): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error(
      `Invalid batch range [${String(start)}, ${String(end)}): expected 0 <= start < end integers.`
    );
  }
  const escapedExpected = JSON.stringify(expectedName);
  const nameGuard = caseInsensitive
    ? `actual.toLowerCase() !== expectedName.toLowerCase()`
    : `actual !== expectedName`;

  const bodiesFetch = includeBody
    ? `
    let bodies = [];
    try {
      bodies = notes.body();
    } catch (bulkBodyErr) {
      bodies = [];
      for (let i = 0; i < ids.length; i++) {
        try {
          const b = notes[i].body();
          bodies.push((b !== undefined && b !== null) ? b : '');
        } catch (singleBodyErr) {
          bodies.push('');
        }
      }
    }`
    : `
    const bodies = [];`;

  const lengthCheck =
    includeBody
      ? `if (ids.length !== names.length || ids.length !== createdList.length || ids.length !== modifiedList.length || ids.length !== bodies.length) {`
      : `if (ids.length !== names.length || ids.length !== createdList.length || ids.length !== modifiedList.length) {`;

  const htmlValue =
    includeBody
      ? `(bodies[i] !== undefined && bodies[i] !== null) ? bodies[i] : ''`
      : `''`;

  return `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const folderIndex = ${folderIndex};
    const expectedName = ${escapedExpected};
    const startIdx = ${start};
    const endIdx = ${end};

    const folder = app.folders()[folderIndex];
    if (!folder) {
      throw new Error('[FOLDER_MISMATCH] Folder at index ' + folderIndex + ' is missing (expected ' + expectedName + ')');
    }
    const actual = folder.name();
    if (${nameGuard}) {
      throw new Error('[FOLDER_MISMATCH] Folder mismatch at index ' + folderIndex + ': expected ' + expectedName + ' but found ' + actual);
    }
    const actualFolderName = actual;

    const notes = folder.notes.slice(startIdx, endIdx - 1);
    const ids = notes.id();
    const names = notes.name();
    const createdList = notes.creationDate();
    const modifiedList = notes.modificationDate();
    ${bodiesFetch}
    ${lengthCheck}
      throw new Error('Bulk fetch length mismatch at index ' + folderIndex + ' [' + startIdx + ', ' + endIdx + ')');
    }

    function toIso(value) {
      try {
        return value ? value.toISOString() : '';
      } catch (isoErr) {
        return '';
      }
    }

    const out = [];
    for (let i = 0; i < ids.length; i++) {
      out.push({
        id: ids[i] || '',
        title: names[i] || '',
        folder: actualFolderName,
        created: toIso(createdList[i]),
        modified: toIso(modifiedList[i]),
        htmlContent: ${htmlValue}
      });
    }

    return JSON.stringify(out);
  `;
}

/**
 * Build JXA that fetches a single note by folder and title (same single-note
 * pattern as getNoteByFolderAndTitle). Returns a JSON RawNoteData object, or
 * null when the note cannot be read. Contains no `.slice(`.
 */
function buildSingleNoteByTitleJxa(
  folderIndex: number,
  expectedName: string,
  title: string,
  includeBody = true,
  caseInsensitive = false
): string {
  const escapedExpected = JSON.stringify(expectedName);
  const escapedTitle = JSON.stringify(title);
  const nameGuard = caseInsensitive
    ? `actual.toLowerCase() !== expectedName.toLowerCase()`
    : `actual !== expectedName`;

  const bodyFetch = includeBody
    ? `try {
        const b = found.body();
        htmlContent = (b !== undefined && b !== null) ? b : '';
      } catch (bodyErr) {
        htmlContent = '';
      }`
    : ``;

  return `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const folderIndex = ${folderIndex};
    const expectedName = ${escapedExpected};
    const targetTitle = ${escapedTitle};

    const folder = app.folders()[folderIndex];
    if (!folder) {
      return JSON.stringify(null);
    }
    const actual = folder.name();
    if (${nameGuard}) {
      return JSON.stringify(null);
    }
    const actualFolderName = actual;

    const matches = folder.notes.whose({ name: targetTitle });
    if (matches.length === 0) {
      return JSON.stringify(null);
    }
    const found = matches[0];

    try {
      let htmlContent = '';
      ${bodyFetch}
      let created = '';
      try {
        const c = found.creationDate();
        created = c ? c.toISOString() : '';
      } catch (createdErr) {}
      let modified = '';
      try {
        const m = found.modificationDate();
        modified = m ? m.toISOString() : '';
      } catch (modifiedErr) {}
      return JSON.stringify({
        id: found.id(),
        title: found.name() || '',
        folder: actualFolderName,
        created: created,
        modified: modified,
        htmlContent: htmlContent
      });
    } catch (refErr) {
      return JSON.stringify(null);
    }
  `;
}

/**
 * Build JXA that fetches a single note by folder and index. Returns a JSON
 * RawNoteData object, or null when the note cannot be read. Last-resort
 * retry when even the titles of a failed batch range are unknown.
 * Contains no `.slice(`.
 */
function buildSingleNoteByIndexJxa(
  folderIndex: number,
  expectedName: string,
  index: number,
  includeBody = true,
  caseInsensitive = false
): string {
  const escapedExpected = JSON.stringify(expectedName);
  const nameGuard = caseInsensitive
    ? `actual.toLowerCase() !== expectedName.toLowerCase()`
    : `actual !== expectedName`;

  const bodyFetch = includeBody
    ? `try {
        const b = ref.body();
        htmlContent = (b !== undefined && b !== null) ? b : '';
      } catch (bodyErr) {
        htmlContent = '';
      }`
    : ``;

  return `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const folderIndex = ${folderIndex};
    const expectedName = ${escapedExpected};
    const targetIdx = ${index};

    const folder = app.folders()[folderIndex];
    if (!folder) {
      return JSON.stringify(null);
    }
    const actual = folder.name();
    if (${nameGuard}) {
      return JSON.stringify(null);
    }
    const actualFolderName = actual;

    const totalNotes = folder.notes.length;
    if (targetIdx < 0 || targetIdx >= totalNotes) {
      return JSON.stringify(null);
    }

    const ref = folder.notes[targetIdx];
    try {
      let htmlContent = '';
      ${bodyFetch}
      let created = '';
      try {
        const c = ref.creationDate();
        created = c ? c.toISOString() : '';
      } catch (createdErr) {}
      let modified = '';
      try {
        const m = ref.modificationDate();
        modified = m ? m.toISOString() : '';
      } catch (modifiedErr) {}
      return JSON.stringify({
        id: ref.id(),
        title: ref.name() || '',
        folder: actualFolderName,
        created: created,
        modified: modified,
        htmlContent: htmlContent
      });
    } catch (refErr) {
      return JSON.stringify(null);
    }
  `;
}

/**
 * Folder enumeration with per-folder note counts from a single JXA call.
 * `counts` parallels `names` when the enumerate payload carried usable
 * per-folder counts; it is `undefined` when counts were missing or corrupt
 * (legacy `{ names, count }` shape, length mismatch, non-numeric entries).
 * Callers with `undefined` counts fall back to per-folder count calls.
 */
interface FolderEnumeration {
  names: string[];
  counts?: number[];
}

/**
 * Parse one enumerate payload into names plus optional counts. Returns
 * `null` when the names half is unusable; returns names without counts when
 * the names half is fine but the counts half is missing or corrupt.
 */
function parseFolderEnumeration(payload: unknown): FolderEnumeration | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (!("names" in payload)) {
    return null;
  }
  const names: unknown = payload.names;
  if (!Array.isArray(names) || !names.every((entry): entry is string => typeof entry === "string")) {
    return null;
  }
  // New shape: parallel per-folder counts.
  if ("counts" in payload) {
    const counts: unknown = payload.counts;
    const usable =
      Array.isArray(counts) &&
      counts.length === names.length &&
      counts.every(
        (entry): entry is number =>
          typeof entry === "number" && Number.isFinite(entry) && entry >= 0
      );
    if (usable) {
      return { names: [...names], counts: (counts as number[]).map((c) => Math.floor(c)) };
    }
    return { names: [...names] };
  }
  // Legacy shape `{ names, count }` (folder count, not per-folder counts):
  // names are usable, counts are simply absent.
  return { names: [...names] };
}

/**
 * Enumerate Apple Notes folders with per-folder note counts in a single JXA
 * call returning `{ names, counts }`. On a names/counts length mismatch (or
 * missing counts) the enumeration is retried once, then the caller falls
 * back to the pre-existing per-folder count path. Cancellation and
 * osascript failures propagate untouched.
 */
async function enumerateFoldersWithCounts(runOpts?: JxaFetchOptions): Promise<FolderEnumeration> {
  const tryOnce = async (): Promise<FolderEnumeration | null> => {
    const raw = await executeJxa<string>(buildFolderEnumerateJxa(), runOpts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return parseFolderEnumeration(parsed);
  };

  const first = await tryOnce();
  if (first && first.counts) {
    return first;
  }
  if (first) {
    debug("Folder enumeration missing per-folder counts, re-enumerating once...");
    const second = await tryOnce();
    if (second && second.counts) {
      return second;
    }
    // Usable names but no trustworthy counts: let the caller fall back to
    // per-folder count calls instead of throwing.
    if (second) {
      return second;
    }
    return first;
  }
  debug("Folder enumeration mismatch, re-enumerating once...");
  const second = await tryOnce();
  if (!second) {
    throw new Error("Failed to enumerate Apple Notes folders (JXA returned no usable folder list).");
  }
  return second;
}

/**
 * Indices of `names` matching `folderName`: exact matches on the content
 * path, case-folded matches on the metadata path. Every matching index is
 * fetched separately, so duplicate folder names aggregate the way the
 * pre-bulk-fetch implementation did.
 */
function filterFolderIndices(names: string[], folderName: string, caseInsensitive: boolean): number[] {
  const indices: number[] = [];
  for (let i = 0; i < names.length; i++) {
    const matches = caseInsensitive
      ? names[i].toLowerCase() === folderName.toLowerCase()
      : names[i] === folderName;
    if (matches) {
      indices.push(i);
    }
  }
  return indices;
}

/** Resolve and validate the per-call batch size for one folder label. */
function resolveBatchSize(requested: number | undefined, label: string): number {
  const batchSize = requested !== undefined ? Math.floor(requested) : getNotesFetchBatchSize();
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error(
      `Invalid batch size ${String(requested ?? getNotesFetchBatchSize())} for folder "${label}": must be a positive integer.`
    );
  }
  return batchSize;
}

/**
 * Stable marker embedded in the folder-guard errors thrown by the
 * batch/count JXA scripts (buildFolderCountJxa, buildFolderBatchJxa).
 * `app.folders()` order shifts when a folder is created or deleted
 * mid-fetch, so a stale enumeration index can point at a different folder
 * (name mismatch) or past the end of the list (missing folder). Both
 * guards throw with this marker so the TS driver can tell "folder list
 * moved" apart from every other batch failure (timeout, poisoned body,
 * length mismatch): only marker errors trigger one re-enumeration plus an
 * index remap, everything else keeps the pre-existing retry/skip path
 * unchanged. Single-note JXA scripts return null on guard failure instead
 * of throwing, so they never carry the marker.
 */
const FOLDER_MISMATCH_MARKER = "FOLDER_MISMATCH";

/** True when `error` is a folder-guard mismatch (see FOLDER_MISMATCH_MARKER). */
function isFolderMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(FOLDER_MISMATCH_MARKER);
}

/**
 * Fetch all notes of one folder, addressed by enumeration index, in small
 * JXA batches.
 *
 * Uses the caller-supplied `knownCount` from the folder enumeration when
 * available and skips the per-folder count call entirely; otherwise it runs
 * the pre-existing count call (length only) as a fallback. Then fetches
 * ranges [start, end) with start += batchSize (default
 * getNotesFetchBatchSize()). Each batch goes through executeJxa with the
 * caller's timeoutMs/signal, is parsed, then reports onBatch with the
 * folder-cumulative fetched count and checks for cancellation.
 *
 * A failed batch never fails the whole fetch: only that batch's index range
 * is retried with single-note JXA calls (same pattern as
 * getNoteByFolderAndTitle — title-based when the range's titles can still be
 * recovered, index-based otherwise). Notes that still fail become
 * `folder/title` entries in `skipped`.
 *
 * A folder created or deleted mid-fetch shifts `app.folders()`, so the
 * enumeration index can go stale: the count/batch guards then throw a
 * FOLDER_MISMATCH error (see FOLDER_MISMATCH_MARKER). Only that marker
 * triggers exactly one re-enumeration plus a remap to the occurrence-th
 * match of the fresh enumeration, retried once (depth max 1); a repeat
 * mismatch, a failed re-enumeration, and every non-marker error keep the
 * pre-existing path above. A folder absent from the fresh enumeration was
 * deleted mid-fetch: the call returns the notes fetched so far plus one
 * skip entry carrying the folder name.
 *
 * @param folderIndex - Index into the most recent folder enumeration
 * @param expectedName - Folder name expected at that index (see
 * buildFolderCountJxa); also used for skip labels and normalization
 * @param opts - Batch size, progress callback, timeout and abort signal.
 * Set `caseInsensitive` for the metadata path (getNoteMetadataByFolder),
 * which restores the pre-bulk-fetch case-insensitive folder lookup.
 * Content/single-note callers keep the default strict match. Pass
 * `knownCount` from the folder enumeration to skip the count call, and
 * `occurrence` (position among the enumeration's same-name matches) so a
 * mid-fetch remap finds the same duplicate folder back.
 * @returns Raw notes (unfiltered) plus skip entries in `folder/title` format
 */
async function fetchFolderIndexBatched(
  folderIndex: number,
  expectedName: string,
  opts?: BulkFetchOptions & { includeBody?: boolean; caseInsensitive?: boolean; knownCount?: number; occurrence?: number }
): Promise<{ notes: RawNoteData[]; skipped: string[] }> {
  const signal = opts?.signal;
  const timeoutMs = opts?.timeoutMs;
  const includeBody = opts?.includeBody ?? true;
  const caseInsensitive = opts?.caseInsensitive ?? false;
  const batchSize = resolveBatchSize(opts?.batchSize, expectedName);
  // Position of this folder among the same-name matches of the caller's
  // enumeration: after a mid-fetch folder-list shift the remap below
  // resolves the occurrence-th match of the fresh enumeration, so
  // duplicate folder names keep their identity.
  const occurrence = opts?.occurrence ?? 0;

  if (signal?.aborted) {
    throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled before start`);
  }

  const runOpts: JxaFetchOptions = { signal, timeoutMs };

  // Stale enumeration index: a folder created or deleted mid-fetch shifts
  // app.folders(), so the working index below is remapped at most once per
  // call (depth max 1); a repeat mismatch keeps the pre-existing path.
  let currentIndex = folderIndex;
  let remapped = false;

  // One re-enumeration plus index lookup for (expectedName, occurrence).
  // "found" carries the fresh index to retry at; "gone" means the folder
  // is absent from the fresh enumeration (deleted mid-fetch); "unknown"
  // means the re-enumeration itself failed and the caller keeps the old
  // error path untouched.
  const tryRemapFolderIndex = async (): Promise<
    { status: "found"; index: number } | { status: "gone" } | { status: "unknown" }
  > => {
    let fresh: FolderEnumeration;
    try {
      fresh = await enumerateFoldersWithCounts(runOpts);
    } catch (remapError) {
      if (remapError instanceof IndexCancelledError) {
        throw remapError;
      }
      return { status: "unknown" };
    }
    const matches = filterFolderIndices(fresh.names, expectedName, caseInsensitive);
    return occurrence < matches.length
      ? { status: "found", index: matches[occurrence] }
      : { status: "gone" };
  };

  const readCount = async (index: number): Promise<number> => {
    const countResult = await executeJxa<string>(
      buildFolderCountJxa(index, expectedName, caseInsensitive),
      runOpts
    );
    return Number(
      typeof countResult === "string" ? JSON.parse(countResult) : countResult
    );
  };

  const runBatch = async (index: number, start: number, end: number): Promise<RawNoteData[]> => {
    const batchResult = await executeJxa<string>(
      buildFolderBatchJxa(index, expectedName, start, end, includeBody, caseInsensitive),
      runOpts
    );
    const batchNotes = JSON.parse(batchResult) as RawNoteData[];
    if (!Array.isArray(batchNotes)) {
      throw new Error(
        `Invalid batch payload for folder "${expectedName}" [${start}, ${end}): expected an array.`
      );
    }
    // No filtering here: even empty notes are kept; the indexer decides.
    return batchNotes.map((item) => normalizeRawNoteData(item, expectedName));
  };

  const knownCount = opts?.knownCount;
  const hasKnownCount =
    typeof knownCount === "number" && Number.isFinite(knownCount) && knownCount >= 0;
  let total: number;
  if (hasKnownCount) {
    total = Math.floor(knownCount as number);
  } else {
    try {
      total = await readCount(currentIndex);
    } catch (countError) {
      if (countError instanceof IndexCancelledError) {
        throw countError;
      }
      if (!remapped && isFolderMismatchError(countError)) {
        const remap = await tryRemapFolderIndex();
        if (remap.status === "gone") {
          return { notes: [], skipped: [expectedName] };
        }
        if (remap.status === "found") {
          currentIndex = remap.index;
          remapped = true;
          // Still failing here (including a second mismatch) keeps the
          // pre-existing behavior: the error propagates to the caller.
          total = await readCount(currentIndex);
        } else {
          throw countError;
        }
      } else {
        throw countError;
      }
    }
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(
      `Failed to count notes in folder "${expectedName}" (JXA returned no usable count).`
    );
  }
  if (total === 0) {
    return { notes: [], skipped: [] };
  }

  const notes: RawNoteData[] = [];
  const skipped: string[] = [];

  for (let start = 0; start < total; start += batchSize) {
    if (signal?.aborted) {
      throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled`);
    }
    const end = Math.min(start + batchSize, total);

    let batch: RawNoteData[] | null = null;
    let failure: unknown = null;
    try {
      batch = await runBatch(currentIndex, start, end);
    } catch (batchError) {
      if (batchError instanceof IndexCancelledError) {
        throw batchError;
      }
      if (signal?.aborted) {
        throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled`);
      }
      failure = batchError;
      // Folder list may have shifted mid-fetch (folder created/deleted):
      // a guard mismatch gets exactly one re-enumeration plus a retry of
      // this batch at the remapped index instead of failing every
      // remaining batch. Any other error skips the remap entirely.
      if (!remapped && isFolderMismatchError(batchError)) {
        const remap = await tryRemapFolderIndex();
        if (remap.status === "gone") {
          // Folder deleted mid-fetch: one skip entry for the folder,
          // notes fetched so far are kept, the caller moves on.
          skipped.push(expectedName);
          break;
        }
        if (remap.status === "found") {
          currentIndex = remap.index;
          remapped = true;
          try {
            batch = await runBatch(currentIndex, start, end);
            failure = null;
          } catch (retryError) {
            if (retryError instanceof IndexCancelledError) {
              throw retryError;
            }
            if (signal?.aborted) {
              throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled`);
            }
            // A second mismatch (or any other retry failure) falls
            // through to the pre-existing recovery below.
            failure = retryError;
          }
        }
      }
    }

    if (batch !== null) {
      for (const item of batch) {
        notes.push(item);
      }
      opts?.onBatch?.(notes.length);
      continue;
    }
    {
      debug(
        `Batch [${start}, ${end}) in folder "${expectedName}" failed, retrying note-by-note:`,
        failure
      );

      // Recover the range's titles with a light metadata-only batch so
      // retries can use the single-note title pattern and permanent
      // failures keep real `folder/title` skip entries.
      let rangeTitles: (string | undefined)[] = [];
      try {
        const metaResult = await executeJxa<string>(
          buildFolderBatchJxa(currentIndex, expectedName, start, end, false, caseInsensitive),
          runOpts
        );
        const metaParsed: unknown = JSON.parse(metaResult);
        if (Array.isArray(metaParsed)) {
          rangeTitles = metaParsed.map((entry) => {
            const title =
              entry && typeof entry === "object" && "title" in entry ? entry.title : undefined;
            return typeof title === "string" && title.length > 0 ? title : undefined;
          });
        }
      } catch (metaError) {
        if (metaError instanceof IndexCancelledError) {
          throw metaError;
        }
        debug(`Metadata recovery for [${start}, ${end}) in folder "${expectedName}" failed:`, metaError);
        rangeTitles = [];
      }

      for (let i = start; i < end; i++) {
        if (signal?.aborted) {
          throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled`);
        }
        const title = rangeTitles[i - start];
        const skipLabel = title !== undefined ? `${expectedName}/${title}` : `${expectedName}/#${i}`;
        try {
          const singleCode =
            title !== undefined
              ? buildSingleNoteByTitleJxa(currentIndex, expectedName, title, includeBody, caseInsensitive)
              : buildSingleNoteByIndexJxa(currentIndex, expectedName, i, includeBody, caseInsensitive);
          const singleResult = await executeJxa<string>(singleCode, runOpts);
          const parsed: unknown =
            typeof singleResult === "string" ? JSON.parse(singleResult) : singleResult;
          const single = (Array.isArray(parsed) ? parsed[0] : parsed) as
            | RawNoteData
            | null
            | undefined;
          if (single && typeof single === "object") {
            notes.push(normalizeRawNoteData(single, expectedName));
            opts?.onBatch?.(notes.length);
          } else {
            skipped.push(skipLabel);
          }
        } catch (singleError) {
          if (singleError instanceof IndexCancelledError) {
            throw singleError;
          }
          debug(`Skipping problematic note: ${skipLabel}`, singleError);
          skipped.push(skipLabel);
        }
      }
      opts?.onBatch?.(notes.length);
    }
  }

  if (signal?.aborted) {
    throw new IndexCancelledError(`Fetch of folder "${expectedName}" cancelled`);
  }

  return { notes, skipped };
}

/**
 * Fetch all notes of the folders named `folderName` in small JXA batches.
 *
 * Enumerates folders once, resolves matching enumeration indices in TS
 * (case-folded on the metadata path, strict otherwise), and fetches every
 * matching index separately so duplicate folder names aggregate.
 *
 * @param folderName - The folder name to fetch notes from
 * @param opts - Batch size, progress callback, timeout and abort signal.
 * Set `caseInsensitive` for the metadata path (getNoteMetadataByFolder),
 * which restores the pre-bulk-fetch case-insensitive folder lookup.
 * Content/single-note callers keep the default strict match.
 * @returns Raw notes (unfiltered) plus skip entries in `folder/title` format
 */
export async function fetchFolderBatched(
  folderName: string,
  opts?: BulkFetchOptions & { includeBody?: boolean; caseInsensitive?: boolean }
): Promise<{ notes: RawNoteData[]; skipped: string[] }> {
  const caseInsensitive = opts?.caseInsensitive ?? false;
  const batchSize = resolveBatchSize(opts?.batchSize, folderName);

  if (opts?.signal?.aborted) {
    throw new IndexCancelledError(`Fetch of folder "${folderName}" cancelled before start`);
  }

  const runOpts: JxaFetchOptions = { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
  const { names, counts } = await enumerateFoldersWithCounts(runOpts);
  const indices = filterFolderIndices(names, folderName, caseInsensitive);

  const notes: RawNoteData[] = [];
  const skipped: string[] = [];
  // The position among the same-name matches is the folder's occurrence:
  // fetchFolderIndexBatched remaps by (name, occurrence) when the folder
  // list shifts mid-fetch, so duplicates keep their identity.
  for (let occurrence = 0; occurrence < indices.length; occurrence++) {
    const folderIndex = indices[occurrence];
    if (opts?.signal?.aborted) {
      throw new IndexCancelledError(`Fetch of folder "${folderName}" cancelled`);
    }
    const base = notes.length;
    const result = await fetchFolderIndexBatched(folderIndex, folderName, {
      ...opts,
      batchSize,
      knownCount: counts?.[folderIndex],
      occurrence,
      onBatch: (fetched) => opts?.onBatch?.(base + fetched),
    });
    notes.push(...result.notes);
    skipped.push(...result.skipped);
  }

  if (opts?.signal?.aborted) {
    throw new IndexCancelledError(`Fetch of folder "${folderName}" cancelled`);
  }

  return { notes, skipped };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Get all notes from Apple Notes with metadata
 *
 * Fetched folder-by-folder in small batched JXA calls (metadata only, no
 * bodies) instead of one call per note.
 *
 * @param opts - Timeout and abort signal
 * @returns Array of note metadata objects
 */
export async function getAllNotes(opts?: JxaFetchOptions): Promise<NoteInfo[]> {
  debug("Getting all notes...");
  const runOpts: JxaFetchOptions = { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
  const { names, counts } = await enumerateFoldersWithCounts(runOpts);

  const allNotes: NoteInfo[] = [];
  for (let folderIndex = 0; folderIndex < names.length; folderIndex++) {
    if (opts?.signal?.aborted) {
      throw new IndexCancelledError("Fetch of all notes cancelled");
    }
    const folderName = names[folderIndex];
    // Occurrence among same-name folders so far (strict match, mirroring
    // the driver call below): lets fetchFolderIndexBatched remap by
    // (name, occurrence) when the folder list shifts mid-fetch.
    let occurrence = 0;
    for (let seen = 0; seen < folderIndex; seen++) {
      if (names[seen] === folderName) {
        occurrence++;
      }
    }
    const { notes } = await fetchFolderIndexBatched(folderIndex, folderName, {
      ...opts,
      includeBody: false,
      knownCount: counts?.[folderIndex],
      occurrence,
    });
    for (const raw of notes) {
      allNotes.push({
        title: raw.title,
        folder: raw.folder,
        created: raw.created,
        modified: raw.modified,
      });
    }
  }

  debug(`Found ${allNotes.length} notes`);
  return allNotes;
}

/**
 * Get a note by its title, with full content
 *
 * @param title - The note title (can be "folder/title" or "id:xxx" format)
 * @returns Note details with content, or null if not found
 */
export async function getNoteByTitle(
  title: string
): Promise<NoteDetails | null> {
  debug(`Getting note by title: ${title}`);

  // Check for id:xxx format for direct ID lookup
  if (title.startsWith("id:")) {
    const noteId = title.slice(3);
    debug(`ID prefix detected, looking up note by ID: ${noteId}`);
    return getNoteById(noteId);
  }

  // Check for folder/title format
  let targetFolder: string | null = null;
  let targetTitle = title;

  if (title.includes("/")) {
    const parts = title.split("/");
    targetFolder = parts.slice(0, -1).join("/");
    targetTitle = parts[parts.length - 1];
    debug(`Parsed folder: ${targetFolder}, title: ${targetTitle}`);
  }

  const escapedTitle = JSON.stringify(targetTitle);
  const escapedFolder = targetFolder ? JSON.stringify(targetFolder) : "null";

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetTitle = ${escapedTitle};
    const targetFolder = ${escapedFolder};

    let foundNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();

      // Skip if folder filter is specified and doesn't match
      if (targetFolder !== null && folderName !== targetFolder) {
        continue;
      }

      const notes = folder.notes.whose({ name: targetTitle });

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();
          foundNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: note.body()
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(foundNotes);
  `;

  const result = await executeJxa<string>(jxaCode);
  const notes = JSON.parse(result) as RawNoteData[];

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  if (notes.length > 1) {
    debug(`Multiple notes found with title: ${targetTitle}`);
    debug("Returning first match. Use folder/title format for disambiguation.");
  }

  debug(`Found note in folder: ${notes[0].folder}`);
  return toNoteDetails(notes[0]);
}

/**
 * Get a note by its Apple Notes ID.
 * Use this for precise access when title-based lookup is ambiguous.
 *
 * @param id - The Apple Notes unique identifier
 * @returns Note details with content, or null if not found
 */
export async function getNoteById(id: string): Promise<NoteDetails | null> {
  debug(`Getting note by ID: ${id}`);

  const escapedId = JSON.stringify(id);

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetId = ${escapedId};

    try {
      const note = app.notes.byId(targetId);
      const props = note.properties();

      // Find the folder this note belongs to
      let folderName = 'Notes';
      const folders = app.folders();
      for (const folder of folders) {
        const notes = folder.notes();
        for (let i = 0; i < notes.length; i++) {
          if (notes[i].id() === targetId) {
            folderName = folder.name();
            break;
          }
        }
      }

      return JSON.stringify({
        id: note.id(),
        title: props.name || '',
        folder: folderName,
        created: props.creationDate ? props.creationDate.toISOString() : '',
        modified: props.modificationDate ? props.modificationDate.toISOString() : '',
        htmlContent: note.body()
      });
    } catch (e) {
      return JSON.stringify(null);
    }
  `;

  const result = await executeJxa<string>(jxaCode);
  const note = JSON.parse(result) as RawNoteData | null;

  if (!note) {
    debug("Note not found by ID");
    return null;
  }

  debug(`Found note: ${note.title} in folder: ${note.folder}`);
  return toNoteDetails(note);
}

/**
 * Get a note by explicit folder and title (no "/" parsing).
 * Use this when you have folder and title separately to avoid
 * issues with "/" characters in note titles.
 *
 * @param folder - The folder name
 * @param title - The note title (can contain "/" characters)
 * @returns Note details with content, or null if not found
 */
export async function getNoteByFolderAndTitle(
  folder: string,
  title: string
): Promise<NoteDetails | null> {
  debug(`Getting note: folder="${folder}", title="${title}"`);

  const escapedTitle = JSON.stringify(title);
  const escapedFolder = JSON.stringify(folder);

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetTitle = ${escapedTitle};
    const targetFolder = ${escapedFolder};

    let foundNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();

      // Only look in the specified folder
      if (folderName !== targetFolder) {
        continue;
      }

      const notes = folder.notes.whose({ name: targetTitle });

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();
          foundNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: note.body()
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(foundNotes);
  `;

  const result = await executeJxa<string>(jxaCode);
  const notes = JSON.parse(result) as RawNoteData[];

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  debug(`Found note in folder: ${notes[0].folder}`);
  return toNoteDetails(notes[0]);
}

/**
 * Get all notes in a specific folder with full content.
 * Used as fallback when getAllNotesWithContent fails on the whole dataset.
 *
 * Fetched in small batched JXA calls; a failed batch is retried note-by-note
 * so a single unreadable note never fails the whole folder.
 *
 * @param folderName - The folder name to fetch notes from
 * @param opts - Batch size, progress callback, timeout and abort signal
 * @returns Array of note details with content from that folder
 */
export async function getNotesInFolder(
  folderName: string,
  opts?: BulkFetchOptions
): Promise<NoteDetails[]> {
  debug(`Getting notes from folder: ${folderName}`);

  const { notes } = await fetchFolderBatched(folderName, opts);

  debug(`Fetched ${notes.length} notes from folder: ${folderName}`);

  return notes.map(toNoteDetails);
}

/**
 * Get all notes with full content using batched JXA calls.
 * Folders are fetched sequentially in small batches (default
 * getNotesFetchBatchSize()) instead of one oversized call, which keeps
 * osascript payloads small and lets a failed batch retry note-by-note
 * without losing the rest.
 *
 * @param opts - Batch size, progress callback, timeout and abort signal
 * @returns Array of note details with content
 */
export async function getAllNotesWithContent(
  opts?: BulkFetchOptions
): Promise<NoteDetails[]> {
  debug("Getting all notes with content (batched JXA calls)...");

  const runOpts: JxaFetchOptions = { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
  const { names, counts } = await enumerateFoldersWithCounts(runOpts);

  const allNotes: NoteDetails[] = [];
  for (let folderIndex = 0; folderIndex < names.length; folderIndex++) {
    if (opts?.signal?.aborted) {
      throw new IndexCancelledError("Fetch of all notes cancelled");
    }
    const folderName = names[folderIndex];
    // Occurrence among same-name folders so far (strict match, mirroring
    // the driver call below): lets fetchFolderIndexBatched remap by
    // (name, occurrence) when the folder list shifts mid-fetch.
    let occurrence = 0;
    for (let seen = 0; seen < folderIndex; seen++) {
      if (names[seen] === folderName) {
        occurrence++;
      }
    }
    const base = allNotes.length;
    const { notes } = await fetchFolderIndexBatched(folderIndex, folderName, {
      ...opts,
      knownCount: counts?.[folderIndex],
      occurrence,
      onBatch: (fetched) => opts?.onBatch?.(base + fetched),
    });
    for (const raw of notes) {
      allNotes.push(toNoteDetails(raw));
    }
  }

  debug(`Fetched ${allNotes.length} notes with content`);

  return allNotes;
}

/** Result type for getAllNotesWithFallback */
export interface FallbackResult {
  /** Successfully fetched notes */
  notes: NoteDetails[];
  /** List of skipped notes (folder/title format) that couldn't be read */
  skipped: string[];
}

/**
 * Get all notes with hybrid fallback strategy for robustness.
 *
 * Strategy:
 * 1. Try batched fetch of all folders (fast path)
 * 2. On failure, try folder-by-folder (batched, collects per-folder skips)
 * 3. On folder failure, try note-by-note within that folder
 *
 * This ensures indexing completes even when some notes are problematic
 * (locked, syncing, corrupted).
 *
 * @param opts - Batch size, progress callback, timeout and abort signal
 * @returns Notes and list of skipped notes
 */
export async function getAllNotesWithFallback(
  opts?: BulkFetchOptions
): Promise<FallbackResult> {
  debug("Getting all notes with fallback strategy...");

  const allNotes: NoteDetails[] = [];
  const skipped: string[] = [];

  // Strategy 1: Try batched fetch (fast path)
  try {
    const notes = await getAllNotesWithContent(opts);
    debug(`Batched fetch succeeded: ${notes.length} notes`);
    return { notes, skipped: [] };
  } catch (singleCallError) {
    if (singleCallError instanceof IndexCancelledError) {
      throw singleCallError;
    }
    debug("Batched fetch failed, falling back to folder-by-folder:", singleCallError);
  }
  // Strategy 2: Folder-by-folder (batched per folder, keeps per-folder skips).
  // The enumeration index doubles as the fetch address, so each folder —
  // including duplicate names — is fetched exactly once without
  // re-enumerating per folder. Per-folder counts ride along from the same
  // enumeration, so no count call runs in the happy path.
  const { names: folders, counts: folderCounts } = await enumerateFoldersWithCounts({
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
  });
  debug(`Trying folder-by-folder approach for ${folders.length} folders`);

  // Cache for note-by-note fallback (loaded lazily only if needed)
  let cachedNotesList: NoteInfo[] | null = null;

  for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
    const folderName = folders[folderIndex];
    if (opts?.signal?.aborted) {
      throw new IndexCancelledError("Fetch of all notes cancelled");
    }
    // Occurrence among same-name folders so far (strict match, mirroring
    // the driver call below): lets fetchFolderIndexBatched remap by
    // (name, occurrence) when the folder list shifts mid-fetch.
    let occurrence = 0;
    for (let seen = 0; seen < folderIndex; seen++) {
      if (folders[seen] === folderName) {
        occurrence++;
      }
    }
    try {
      const base = allNotes.length;
      const { notes, skipped: folderSkipped } = await fetchFolderIndexBatched(folderIndex, folderName, {
        ...opts,
        knownCount: folderCounts?.[folderIndex],
        occurrence,
        onBatch: (fetched) => opts?.onBatch?.(base + fetched),
      });
      for (const raw of notes) {
        allNotes.push(toNoteDetails(raw));
      }
      skipped.push(...folderSkipped);
      debug(`Folder "${folderName}": ${notes.length} notes`);
    } catch (folderError) {
      if (folderError instanceof IndexCancelledError) {
        throw folderError;
      }
      debug(`Folder "${folderName}" failed, falling back to note-by-note:`, folderError);

      // Strategy 3: Note-by-note for this folder
      // Load notes list once and cache for subsequent folder failures
      if (cachedNotesList === null) {
        cachedNotesList = await getAllNotes();
      }
      const folderNoteTitles = cachedNotesList
        .filter((n) => n.folder === folderName)
        .map((n) => n.title);

      for (const noteTitle of folderNoteTitles) {
        try {
          const note = await getNoteByFolderAndTitle(folderName, noteTitle);
          if (note) {
            allNotes.push(note);
          } else {
            skipped.push(`${folderName}/${noteTitle}`);
          }
        } catch (noteError) {
          debug(`Skipping problematic note: ${folderName}/${noteTitle}`, noteError);
          skipped.push(`${folderName}/${noteTitle}`);
        }
      }
    }
  }

  debug(`Fallback complete: ${allNotes.length} notes, ${skipped.length} skipped`);
  return { notes: allNotes, skipped };
}

/**
 * Get all folder names from Apple Notes
 *
 * @param opts - Timeout and abort signal
 * @returns Array of folder names
 */
export async function getAllFolders(opts?: JxaFetchOptions): Promise<string[]> {
  debug("Getting all folders...");

  const { names: folders } = await enumerateFoldersWithCounts(opts);

  debug(`Found ${folders.length} folders`);
  return folders;
}

// -----------------------------------------------------------------------------
// List Notes with Sorting and Filtering
// -----------------------------------------------------------------------------

// Re-export ListNotesOptions from index.ts (derived from Zod schema - single source of truth)
export type { ListNotesOptions } from "../index.js";

// Import the type for internal use
import type { ListNotesOptions } from "../index.js";

/**
 * Get notes metadata from a specific folder (no content).
 * Fetched in small batched JXA calls without bodies. The folder lookup is
 * case-insensitive (pre-bulk-fetch behavior): results keep the original
 * Notes folder name.
 *
 * @param folderName - The folder name
 * @param opts - Timeout and abort signal
 * @returns Array of note metadata from the specified folder
 */
export async function getNoteMetadataByFolder(
  folderName: string,
  opts?: JxaFetchOptions
): Promise<NoteInfo[]> {
  debug(`Getting note metadata for folder: ${folderName}`);

  const { notes } = await fetchFolderBatched(folderName, { ...opts, includeBody: false, caseInsensitive: true });

  const result = notes.map((raw) => ({
    title: raw.title,
    folder: raw.folder,
    created: raw.created,
    modified: raw.modified,
  }));

  debug(`Found ${result.length} notes in folder: ${folderName}`);
  return result;
}

/**
 * List notes with sorting and filtering.
 *
 * When a folder filter is provided, only that folder is queried via JXA
 * instead of fetching all notes first. This is significantly faster for
 * users with many notes spread across folders.
 *
 * @param options - Sorting and filtering options
 * @returns Array of note metadata sorted and filtered as specified
 */
export async function listNotes(options: ListNotesOptions = {}): Promise<NoteInfo[]> {
  const { sort_by = "modified", order = "desc", limit, folder } = options;

  debug(`Listing notes: sort_by=${sort_by}, order=${order}, limit=${limit}, folder=${folder}`);

  const filtered = folder
    ? await getNoteMetadataByFolder(folder)
    : await getAllNotes();

  filtered.sort((a, b) => {
    let comparison: number;

    if (sort_by === "title") {
      comparison = a.title.localeCompare(b.title);
    } else {
      // Handle empty dates by treating them as epoch (0)
      const aTime = a[sort_by] ? new Date(a[sort_by]).getTime() : 0;
      const bTime = b[sort_by] ? new Date(b[sort_by]).getTime() : 0;
      comparison = aTime - bTime;
    }

    return order === "desc" ? -comparison : comparison;
  });

  const result = limit ? filtered.slice(0, limit) : filtered;

  debug(`Returning ${result.length} notes`);
  return result;
}
