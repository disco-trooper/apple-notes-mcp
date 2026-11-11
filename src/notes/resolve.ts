/**
 * Note and folder resolution.
 *
 * Turns user input (`title`, `folder/title`, `id:xxx`) into one specific
 * note, and hosts the JXA folder helpers every folder-addressing script
 * shares. This is the only place that looks notes up by title.
 */

import { createDebugLogger } from "../utils/debug.js";
import type { NoteSuggestion } from "../errors/index.js";
import { executeJxa } from "./jxa-runner.js";

const debug = createDebugLogger("NOTES");

/**
 * Result of resolving user input to a specific note.
 */
export interface ResolvedNote {
  /** Whether resolution was successful */
  success: boolean;
  /** The matched note (if exactly one match) */
  note?: {
    id: string;
    title: string;
    folder: string;
  };
  /** Error message if resolution failed */
  error?: string;
  /** Rich suggestions when multiple matches found (includes ID and created date) */
  suggestions?: NoteSuggestion[];
}

/** One interpretation of user input: a title, optionally scoped to a folder. */
export interface NoteLookupCandidate {
  title: string;
  /** Folder reference (leaf name, nested path, or `Account/path`); null = any folder */
  folder: string | null;
}

/**
 * Names of Apple Notes' trash folder. Notes reports the folder under the
 * system language's name (once per account), so English plus the common
 * localizations are built in; NOTES_TRASH_FOLDER adds any other one.
 */
const BUILTIN_TRASH_FOLDER_NAMES = [
  "Recently Deleted",
  "Nedávno smazané", // cs
  "Zuletzt gelöscht", // de
  "Suppressions récentes", // fr
  "Eliminado recientemente", // es
  "Eliminati di recente", // it
  "Ostatnio usunięte", // pl
  "Nedávno vymazané", // sk
  "Recent verwijderd", // nl
  "Apagadas recentemente", // pt
  "Nylig slettet", // nb
  "Nyligen raderade", // sv
  "Nyligt slettet", // da
];

/** Comparison key: trimmed, NFC, lowercased. Mirrored by the JXA isTrashFolder. */
function normalizeFolderName(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** Normalized trash folder names, read once at load (the .env is loaded first). */
const TRASH_FOLDER_NAMES: string[] = [
  ...BUILTIN_TRASH_FOLDER_NAMES,
  ...(process.env.NOTES_TRASH_FOLDER?.trim() ? [process.env.NOTES_TRASH_FOLDER] : []),
].map(normalizeFolderName);

/**
 * True for the trash folder (case-insensitive exact name, any account, any
 * known language). Trashed notes are never listed, indexed, resolved by
 * title or targeted by folder writes; only `id:` lookups can still reach one.
 */
export function isTrashFolderName(name: string): boolean {
  return TRASH_FOLDER_NAMES.includes(normalizeFolderName(name));
}

/**
 * JXA helpers shared by every script that addresses folders. Expects `app`
 * (Application('Notes')) in scope.
 *
 * - `isTrashFolder(f)`: the trash folder in any known language (see
 *   isTrashFolderName; same name list).
 * - `folderPathInfo(f)`: leaf name, nested path (`Parent/Child`) and account
 *   name. `app.folders()` is flat (nested folders included), so the path is
 *   rebuilt from the `container()` chain.
 * - `folderMatches(f, ref)`: `ref` is the leaf name, the nested path, or
 *   `Account/path`.
 * - `findFolder(ref, label)`: exactly one non-trash folder or a thrown
 *   Error. A name shared by several folders (e.g. "Notes" in iCloud and On
 *   My Mac) throws with every `Account/path`, which the caller can pass back
 *   to pick one.
 */
export const FOLDER_JXA_HELPERS = `
    function isTrashFolder(f) {
      return ${JSON.stringify(TRASH_FOLDER_NAMES)}.indexOf(
        String(f.name()).trim().normalize('NFC').toLowerCase()
      ) !== -1;
    }

    function folderPathInfo(f) {
      const parts = [f.name()];
      let c = f.container();
      for (let guard = 0; guard < 64 && c.properties().pcls === 'folder'; guard++) {
        parts.unshift(c.name());
        c = c.container();
      }
      let account = '';
      try { account = c.name(); } catch (accountErr) {}
      return { leaf: parts[parts.length - 1], path: parts.join('/'), account: account };
    }

    function folderMatches(f, ref) {
      if (f.name() === ref) {
        return true;
      }
      const info = folderPathInfo(f);
      return ref === info.path || ref === info.account + '/' + info.path;
    }

    function findFolder(ref, label) {
      let hits = app.folders.whose({ name: ref })();
      if (hits.length === 0 && ref.indexOf('/') !== -1) {
        hits = app.folders().filter(function (f) {
          const info = folderPathInfo(f);
          return ref === info.path || ref === info.account + '/' + info.path;
        });
      }
      hits = hits.filter(function (f) { return !isTrashFolder(f); });
      if (hits.length === 0) {
        throw new Error(label + ' not found: ' + ref);
      }
      if (hits.length > 1) {
        const where = hits.map(function (f) {
          const info = folderPathInfo(f);
          return info.account + '/' + info.path;
        });
        throw new Error('Multiple folders match "' + ref + '": ' + where.join(', ') +
          '. Use the "Account/Folder" form to pick one.');
      }
      return hits[0];
    }
`;

/**
 * Interpretations of title input, most literal first: the whole input as a
 * title, then every `/` split point from right to left (folder = left part,
 * title = right part). Splits with an empty folder or title are skipped, so
 * titles like "2024/05/12 Standup" stay resolvable.
 */
export function buildLookupCandidates(input: string): NoteLookupCandidate[] {
  const candidates: NoteLookupCandidate[] = [{ title: input, folder: null }];
  const parts = input.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const folder = parts.slice(0, i).join("/");
    const title = parts.slice(i).join("/");
    if (folder.length > 0 && title.length > 0) {
      candidates.push({ title, folder });
    }
  }
  return candidates;
}

/**
 * JXA that tries each candidate in order and stops at the first one with
 * matches. Returns JSON: one array of `{ id, title, folder, created }`
 * matches per tried candidate. Notes in "Recently Deleted" never match.
 * Uses bulk getters on the `whose` result; only the folder needs a
 * per-match lookup.
 */
function buildFindNotesJxa(candidates: NoteLookupCandidate[]): string {
  return `
    const app = Application('Notes');
    const candidates = ${JSON.stringify(candidates)};
    ${FOLDER_JXA_HELPERS}

    const results = [];
    for (const cand of candidates) {
      const found = [];
      const matches = app.notes.whose({ name: cand.title });
      const ids = matches.id();
      const names = ids.length > 0 ? matches.name() : [];
      const createdList = ids.length > 0 ? matches.creationDate() : [];
      for (let i = 0; i < ids.length; i++) {
        try {
          const folder = app.notes.byId(ids[i]).container();
          if (isTrashFolder(folder) || (cand.folder !== null && !folderMatches(folder, cand.folder))) {
            continue;
          }
          const created = createdList[i];
          found.push({
            id: ids[i],
            title: names[i] || '',
            folder: folder.name(),
            created: created ? created.toISOString() : ''
          });
        } catch (noteErr) {
          // Skip notes that can't be accessed
        }
      }
      results.push(found);
      if (found.length > 0) {
        break;
      }
    }

    return JSON.stringify(results);
  `;
}

/** JXA returning `{ id, title, folder }` for a note id, or null. No body read. */
function buildNoteRefByIdJxa(id: string): string {
  return `
    const app = Application('Notes');
    const note = app.notes.byId(${JSON.stringify(id)});
    if (!note.exists()) {
      return JSON.stringify(null);
    }
    return JSON.stringify({ id: note.id(), title: note.name(), folder: note.container().name() });
  `;
}

interface NoteMatch {
  id: string;
  title: string;
  folder: string;
  created: string;
}

/**
 * Resolve user input to a unique note.
 *
 * Handles:
 * - "id:xxx" for direct ID lookup
 * - the whole input as an exact title (titles may contain "/")
 * - "folder/title", where folder is a leaf name, nested path or
 *   "Account/path"; tried at every "/" when the whole input matches nothing
 * - suggestions (id, folder, created) when several notes match
 *
 * @param input - The note title, "folder/title", or "id:xxx" string
 * @returns Resolution result with success status, note info, or suggestions
 */
export async function resolveNoteTitle(input: string): Promise<ResolvedNote> {
  debug(`Resolving note title: ${input}`);

  if (input.startsWith("id:")) {
    const noteId = input.slice(3);
    const note = JSON.parse(await executeJxa<string>(buildNoteRefByIdJxa(noteId))) as
      | { id: string; title: string; folder: string }
      | null;
    if (!note) {
      return { success: false, error: `Note not found with ID: "${noteId}"` };
    }
    return { success: true, note };
  }

  const candidates = buildLookupCandidates(input);
  const perCandidate = JSON.parse(
    await executeJxa<string>(buildFindNotesJxa(candidates))
  ) as NoteMatch[][];
  const matchIndex = perCandidate.findIndex((found) => found.length > 0);

  if (matchIndex === -1) {
    debug("No matching notes found");
    return { success: false, error: `Note not found: "${input}"` };
  }

  const notes = perCandidate[matchIndex];
  if (notes.length === 1) {
    const { id, title, folder } = notes[0];
    debug(`Resolved to unique note: ${folder}/${title}`);
    return { success: true, note: { id, title, folder } };
  }

  const suggestions: NoteSuggestion[] = notes.map((n) => ({
    id: n.id,
    folder: n.folder,
    title: n.title,
    created: n.created,
  }));
  debug(`Multiple matches found: ${suggestions.map((s) => `${s.folder}/${s.title}`).join(", ")}`);

  return {
    success: false,
    error: `Multiple notes found with title "${candidates[matchIndex].title}". Use ID prefix to specify.`,
    suggestions,
  };
}
