import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./jxa-runner.js", () => ({
  executeJxa: vi.fn(),
}));

import { executeJxa } from "./jxa-runner.js";
import { FOLDER_JXA_HELPERS, isTrashFolderName, resolveNoteTitle } from "./resolve.js";

/**
 * Minimal in-memory stand-in for Application('Notes'), enough for the
 * generated scripts: flat `folders` (with `whose` by case-insensitive name,
 * like Notes), `notes.whose` / `notes.byId`, and container chains ending at
 * an account.
 */
interface FakeNote {
  id: string;
  name: string;
  folder: string;
}

function fakeNotes(accounts: Record<string, string[]>, notes: FakeNote[]) {
  const folders = Object.entries(accounts).flatMap(([account, names]) =>
    names.map((name) => {
      const accountObj = { name: () => account, properties: () => ({ pcls: "account" }) };
      return { key: `${account}/${name}`, name: () => name, container: () => accountObj };
    })
  );
  const folderByKey = new Map(folders.map((f) => [f.key, f]));
  const noteList = (list: FakeNote[]) => ({
    id: () => list.map((n) => n.id),
    name: () => list.map((n) => n.name),
    creationDate: () => list.map(() => new Date("2026-01-01T00:00:00Z")),
  });
  const folderFns = () => folders;
  return {
    folders: Object.assign(folderFns, {
      whose: ({ name }: { name: string }) => () =>
        folders.filter((f) => f.name().toLowerCase() === name.toLowerCase()),
    }),
    notes: {
      whose: ({ name }: { name: string }) =>
        noteList(notes.filter((n) => n.name.toLowerCase() === name.toLowerCase())),
      byId: (id: string) => ({
        container: () => folderByKey.get(notes.find((n) => n.id === id)?.folder ?? ""),
      }),
    },
  };
}

/** Run a generated script body (top-level `return`) against a fake app. */
function runScript(code: string, app: unknown): unknown {
  return new Function("Application", code)(() => app);
}

const LIBRARY = fakeNotes(
  { iCloud: ["Notes", "Recently Deleted", "Work"], "On My Mac": ["Notes", "recently deleted"] },
  [
    { id: "live", name: "Plan", folder: "iCloud/Work" },
    { id: "trashed", name: "Plan", folder: "iCloud/Recently Deleted" },
    { id: "trashed-local", name: "Plan", folder: "On My Mac/recently deleted" },
  ]
);

describe("isTrashFolderName", () => {
  it.each([
    ["Recently Deleted", true],
    ["recently deleted", true],
    ["  RECENTLY DELETED ", true],
    ["Recently Deleted Stuff", false],
    ["Nedávno smazané", true],
    ["nedávno smazané", true],
    ["Nedávno smazané".normalize("NFD"), true],
    ["Zuletzt gelöscht", true],
    ["Suppressions récentes", true],
    ["Nyligt slettet", true],
    ["Notes", false],
  ])("%j -> %s", (name, expected) => {
    expect(isTrashFolderName(name)).toBe(expected);
  });
});

describe("findFolder (shared JXA helper)", () => {
  const findFolder = (ref: string): unknown =>
    runScript(`const app = Application(); ${FOLDER_JXA_HELPERS} return findFolder(${JSON.stringify(ref)}, 'Folder').key;`, LIBRARY);

  it("never targets the trash folder", () => {
    expect(() => findFolder("Recently Deleted")).toThrow("Folder not found: Recently Deleted");
    expect(() => findFolder("iCloud/Recently Deleted")).toThrow("Folder not found");
  });

  it("lists every account when a name is ambiguous", () => {
    expect(() => findFolder("Notes")).toThrow('Multiple folders match "Notes": iCloud/Notes, On My Mac/Notes');
  });

  it("accepts the Account/Folder form", () => {
    expect(findFolder("On My Mac/Notes")).toBe("On My Mac/Notes");
  });

  it("never targets a localized trash folder", () => {
    const czech = fakeNotes({ iCloud: ["Poznámky", "Nedávno smazané"] }, []);
    const find = (ref: string): unknown =>
      runScript(`const app = Application(); ${FOLDER_JXA_HELPERS} return findFolder(${JSON.stringify(ref)}, 'Folder').key;`, czech);
    expect(() => find("Nedávno smazané")).toThrow("Folder not found: Nedávno smazané");
    expect(find("Poznámky")).toBe("iCloud/Poznámky");
  });
});

describe("NOTES_TRASH_FOLDER", () => {
  afterEach(() => {
    delete process.env.NOTES_TRASH_FOLDER;
    vi.resetModules();
  });

  it("adds an extra trash name for both the TS check and the JXA helper", async () => {
    process.env.NOTES_TRASH_FOLDER = " Papierkorb ";
    vi.resetModules();
    // Dynamic import: the name list is read at module load, so a fresh module is needed.
    const fresh = await import("./resolve.js");

    expect(fresh.isTrashFolderName("papierkorb")).toBe(true);
    expect(fresh.isTrashFolderName("Recently Deleted")).toBe(true);

    const library = fakeNotes({ iCloud: ["Notes", "Papierkorb"] }, []);
    expect(() =>
      runScript(`const app = Application(); ${fresh.FOLDER_JXA_HELPERS} return findFolder('Papierkorb', 'Folder');`, library)
    ).toThrow("Folder not found: Papierkorb");
    // Without the override the folder is a normal one.
    expect(isTrashFolderName("Papierkorb")).toBe(false);
  });
});

describe("resolveNoteTitle trash filtering", () => {
  beforeEach(() => {
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockImplementation(async (code: string) => runScript(code, LIBRARY) as never);
  });

  it("ignores trashed copies of a title, so the live note resolves uniquely", async () => {
    await expect(resolveNoteTitle("Plan")).resolves.toEqual({
      success: true,
      note: { id: "live", title: "Plan", folder: "Work" },
    });
  });

  it("does not resolve a note through the trash folder", async () => {
    const result = await resolveNoteTitle("Recently Deleted/Plan");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
