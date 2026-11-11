import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./jxa-runner.js", () => ({
  executeJxa: vi.fn(),
}));

vi.mock("marked", () => ({
  marked: {
    parse: vi.fn((text: string) => `<p>${text}</p>`),
  },
}));

// Keep the real JXA folder helpers (they end up in generated scripts);
// only the title resolution round trip is faked.
vi.mock("./resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve.js")>()),
  resolveNoteTitle: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({
  createDebugLogger: vi.fn(() => vi.fn()),
}));

vi.mock("./tables.js", () => ({
  applyTableEdits: vi.fn(),
}));

import { executeJxa } from "./jxa-runner.js";
import {
  checkReadOnly,
  createNote,
  updateNote,
  deleteNote,
  moveNote,
  editTable,
  batchDelete,
  batchMove,
} from "./crud.js";
import { resolveNoteTitle } from "./resolve.js";
import { applyTableEdits } from "./tables.js";

const WORK_NOTE = { id: "123", title: "Test", folder: "Work" };

function resolvesTo(note = WORK_NOTE): void {
  vi.mocked(resolveNoteTitle).mockResolvedValueOnce({ success: true, note });
}

function scriptOf(call: number): string {
  return String(vi.mocked(executeJxa).mock.calls[call][0]);
}

/** Value of `const <name> = <JSON literal>;` in a generated script. */
function constLiteral(script: string, name: string): unknown {
  const match = script.match(new RegExp(`const ${name} = ("(?:[^"\\\\]|\\\\.)*"|null);`));
  if (!match) {
    throw new Error(`const ${name} not found in script`);
  }
  return JSON.parse(match[1]);
}

/** Value of `const <name> = <JSON array literal>;` in a generated script. */
function constLiteralJson(script: string, name: string): unknown {
  const match = script.match(new RegExp(`const ${name} = (\\[.*?\\]);`));
  if (!match) {
    throw new Error(`const ${name} not found in script`);
  }
  return JSON.parse(match[1]);
}

const DUPLICATE_RESOLUTION = {
  success: false,
  error: "Multiple notes found",
  suggestions: [
    { id: "id-1", folder: "Work", title: "Note", created: "2026-01-09T10:00:00.000Z" },
    { id: "id-2", folder: "Personal", title: "Note", created: "2026-01-09T11:00:00.000Z" },
  ],
};

beforeEach(() => {
  vi.mocked(executeJxa).mockReset();
  vi.mocked(resolveNoteTitle).mockReset();
  vi.mocked(applyTableEdits).mockReset();
  delete process.env.READONLY_MODE;
});

afterEach(() => {
  delete process.env.READONLY_MODE;
  delete process.env.NOTES_FETCH_BATCH_SIZE;
});

describe("checkReadOnly", () => {
  it.each([
    [undefined, false],
    ["false", false],
    ["0", false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
  ])("READONLY_MODE=%s blocks writes: %s", (value, blocked) => {
    if (value !== undefined) {
      process.env.READONLY_MODE = value;
    }
    if (blocked) {
      expect(() => checkReadOnly()).toThrow("read-only mode");
    } else {
      expect(() => checkReadOnly()).not.toThrow();
    }
  });
});

describe("READONLY_MODE", () => {
  it.each([
    ["createNote", () => createNote("Test", "Content")],
    ["updateNote", () => updateNote("Test", "Content")],
    ["deleteNote", () => deleteNote("Test")],
    ["moveNote", () => moveNote("Test", "Archive")],
    ["editTable", () => editTable("Test", 0, [])],
    ["batchDelete", () => batchDelete({ titles: ["Test"] })],
    ["batchMove", () => batchMove({ sourceFolder: "Temp", targetFolder: "Archive" })],
  ])("%s refuses to run without touching Notes", async (_name, run) => {
    process.env.READONLY_MODE = "true";
    await expect(run()).rejects.toThrow("read-only mode");
    expect(executeJxa).not.toHaveBeenCalled();
    expect(resolveNoteTitle).not.toHaveBeenCalled();
  });
});

describe("generated scripts embed user strings as JSON literals", () => {
  const hostile = [
    `quote " and 'single'`,
    "back\\slash \\\" mix",
    "multi\nline\r\nvalue",
    "line\u2028separator\u2029para",
    "'); app.quit(); ('",
    '"); app.quit(); ("',
    "`${app.quit()}`",
  ];

  it.each(hostile)("createNote round-trips title and folder %j", async (value) => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ id: "n", title: value, folder: value }));

    await createNote(value, "body", value);

    const script = scriptOf(0);
    expect(constLiteral(script, "title")).toBe(value);
    expect(constLiteral(script, "folderName")).toBe(value);
    expect(script).toContain(`const title = ${JSON.stringify(value)};`);
  });

  it.each(hostile)("updateNote round-trips the body %j", async (value) => {
    resolvesTo();
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ newTitle: "Test" }));

    await updateNote("Test", value);

    expect(scriptOf(0)).toContain(`note.body = ${JSON.stringify(`<p>${value}</p>`)};`);
  });

  it.each(hostile)("moveNote round-trips the folder %j", async (value) => {
    resolvesTo({ id: value, title: "Test", folder: "Work" });
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ toFolder: "Archive" }));

    await moveNote("Test", value);

    const script = scriptOf(0);
    expect(script).toContain(`findFolder(${JSON.stringify(value)}, 'Folder')`);
    expect(script).toContain(`app.notes.byId(${JSON.stringify(value)})`);
  });
});

describe("createNote", () => {
  it("passes the title as the note name and leaves other content untouched", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify({ id: "note-1", title: "Groceries", folder: "Work" })
    );

    await expect(createNote("Groceries", "milk\neggs", "Work")).resolves.toEqual({
      id: "note-1",
      title: "Groceries",
      folder: "Work",
      requestedTitle: "Groceries",
      titleChanged: false,
    });
    const script = scriptOf(0);
    expect(constLiteral(script, "title")).toBe("Groceries");
    expect(script).toContain("app.Note({name: title, body: content})");
    expect(constLiteral(script, "content")).toBe("<p>milk\neggs</p>");
  });

  it.each(["# Groceries\n\nmilk", "Groceries\nmilk", "  ## Groceries  \nmilk", "\n\n# Groceries\nmilk"])(
    "drops a first line repeating the title, since Notes already writes it (%j)",
    async (content) => {
      vi.mocked(executeJxa).mockResolvedValueOnce(
        JSON.stringify({ id: "n", title: "Groceries", folder: "Notes" })
      );

      await createNote("Groceries", content);

      expect(constLiteral(scriptOf(0), "content")).toBe("<p>milk</p>");
    }
  );

  it.each(["Groceries\n=========\nmilk", "Groceries\n---\n\nmilk", "Groceries\n   ==  \nmilk"])(
    "drops a setext title together with its underline (%j)",
    async (content) => {
      vi.mocked(executeJxa).mockResolvedValueOnce(
        JSON.stringify({ id: "n", title: "Groceries", folder: "Notes" })
      );

      await createNote("Groceries", content);

      expect(constLiteral(scriptOf(0), "content")).toBe("<p>milk</p>");
    }
  );

  it("keeps a horizontal rule that follows an ATX title", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ id: "n", title: "Groceries", folder: "Notes" }));

    await createNote("Groceries", "# Groceries\n---\nmilk");

    expect(constLiteral(scriptOf(0), "content")).toBe("<p>---\nmilk</p>");
  });

  it("keeps a first line that only starts like the title", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ id: "n", title: "Groceries", folder: "Notes" }));

    await createNote("Groceries", "Groceries list\nmilk");

    expect(constLiteral(scriptOf(0), "content")).toBe("<p>Groceries list\nmilk</p>");
  });

  it("uses the default folder when none is given", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ id: "n", title: "T", folder: "Notes" }));

    await createNote("T", "body");

    expect(constLiteral(scriptOf(0), "folderName")).toBeNull();
    expect(scriptOf(0)).toContain("defaultFolder()");
  });

  it("reports a title Apple Notes changed", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ id: "n", title: "Other", folder: "Notes" }));

    const result = await createNote("Requested", "body");
    expect(result).toMatchObject({ title: "Other", requestedTitle: "Requested", titleChanged: true });
  });

  it("propagates an ambiguous folder error", async () => {
    vi.mocked(executeJxa).mockRejectedValueOnce(
      new Error('JXA execution failed: Multiple folders match "Notes": iCloud/Notes, On My Mac/Notes.')
    );

    await expect(createNote("T", "body", "Notes")).rejects.toThrow("iCloud/Notes, On My Mac/Notes");
  });
});

describe("updateNote", () => {
  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({ success: false, error: "Note not found" });
    await expect(updateNote("Missing Note", "Content")).rejects.toThrow("Note not found");
  });

  it("should update note successfully", async () => {
    resolvesTo();
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ newTitle: "Test" }));

    await expect(updateNote("Test", "New Content")).resolves.toEqual({
      id: "123",
      originalTitle: "Test",
      newTitle: "Test",
      folder: "Work",
      titleChanged: false,
    });
  });

  it("should detect when Apple Notes renames the note", async () => {
    resolvesTo({ id: "123", title: "Original Title", folder: "Work" });
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ newTitle: "New Heading" }));

    const result = await updateNote("Original Title", "# New Heading\n\nContent");
    expect(result).toMatchObject({ newTitle: "New Heading", titleChanged: true });
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce(DUPLICATE_RESOLUTION);
    await expect(updateNote("Note", "Content")).rejects.toThrow("Use ID prefix");
  });
});

describe("deleteNote", () => {
  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({ success: false, error: "Note not found" });
    await expect(deleteNote("Missing Note")).rejects.toThrow("Note not found");
  });

  it("should delete the resolved note by id", async () => {
    resolvesTo();
    vi.mocked(executeJxa).mockResolvedValueOnce("ok");

    await expect(deleteNote("Test")).resolves.toEqual(WORK_NOTE);
    expect(scriptOf(0)).toContain('app.notes.byId("123")');
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce(DUPLICATE_RESOLUTION);
    await expect(deleteNote("Note")).rejects.toThrow("Use ID prefix");
  });
});

describe("moveNote", () => {
  it("should report the folder Notes actually moved the note to", async () => {
    resolvesTo();
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify({ toFolder: "Archive" }));

    await expect(moveNote("Test", "iCloud/Archive")).resolves.toEqual({
      id: "123",
      title: "Test",
      fromFolder: "Work",
      toFolder: "Archive",
    });
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce(DUPLICATE_RESOLUTION);
    await expect(moveNote("Note", "Archive")).rejects.toThrow("Use ID prefix");
  });
});

describe("editTable", () => {
  const edits = [{ row: 1, column: 0, value: "✅ Done" }];

  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({ success: false, error: "Note not found" });
    await expect(editTable("Missing", 0, edits)).rejects.toThrow("Note not found");
  });

  it("should propagate out-of-range errors without writing", async () => {
    resolvesTo();
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify({ html: "<div>No tables</div>", modified: "2026-01-01T00:00:00.000Z" })
    );
    vi.mocked(applyTableEdits).mockImplementationOnce(() => {
      throw new Error("Table index 0 out of bounds (note has 0 tables)");
    });

    await expect(editTable("Test", 0, edits)).rejects.toThrow("Table index 0 out of bounds");
    expect(executeJxa).toHaveBeenCalledTimes(1);
  });

  it("should write the edited HTML guarded by the read-time modification date", async () => {
    resolvesTo();
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(JSON.stringify({ html: "<table>old</table>", modified: "2026-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(JSON.stringify({ title: "Test", folder: "Work" }));
    vi.mocked(applyTableEdits).mockReturnValueOnce("<table>new $& $1</table>");

    await expect(editTable("Test", 0, edits)).resolves.toEqual(WORK_NOTE);

    expect(applyTableEdits).toHaveBeenCalledWith("<table>old</table>", 0, edits);
    const write = scriptOf(1);
    expect(write).toContain(`note.body = ${JSON.stringify("<table>new $& $1</table>")};`);
    expect(write).toContain(`!== ${JSON.stringify("2026-01-01T00:00:00.000Z")}`);
    expect(write.indexOf("modificationDate()")).toBeLessThan(write.indexOf("note.body ="));
  });

  it("should also guard the write by the read-time body, since dates have second precision", async () => {
    resolvesTo();
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(JSON.stringify({ html: "<table>old \"q\"</table>", modified: "2026-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(JSON.stringify({ title: "Test", folder: "Work" }));
    vi.mocked(applyTableEdits).mockReturnValueOnce("<table>new</table>");

    await editTable("Test", 0, edits);

    const write = scriptOf(1);
    expect(write).toContain(`note.body() !== ${JSON.stringify("<table>old \"q\"</table>")}`);
    expect(write.indexOf("note.body() !==")).toBeLessThan(write.indexOf("note.body ="));
  });

  it("should surface a concurrent modification instead of overwriting", async () => {
    resolvesTo();
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(JSON.stringify({ html: "<table></table>", modified: "2026-01-01T00:00:00.000Z" }))
      .mockRejectedValueOnce(new Error("JXA execution failed: Note was modified while the table edit was prepared"));
    vi.mocked(applyTableEdits).mockReturnValueOnce("<table>new</table>");

    await expect(editTable("Test", 0, edits)).rejects.toThrow("Note was modified");
  });
});

describe("batchDelete", () => {
  it("should throw if both titles and folder provided", async () => {
    await expect(batchDelete({ titles: ["Note"], folder: "Folder" })).rejects.toThrow(
      "Specify either titles or folder, not both"
    );
  });

  it("should throw if neither titles nor folder provided", async () => {
    await expect(batchDelete({})).rejects.toThrow("Specify either titles or folder");
  });

  it("should list a folder once, then delete by id in groups and keep finished groups", async () => {
    process.env.NOTES_FETCH_BATCH_SIZE = "2";
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(
        JSON.stringify({ folderName: "Old", ids: ["a", "b", "c", "d", "e"], names: ["A", "B", "", "D", "E"] })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ deleted: [{ id: "a", title: "A", folder: "Old" }], failed: ["B"] })
      )
      .mockRejectedValueOnce(new Error("JXA timed out"))
      .mockResolvedValueOnce(JSON.stringify({ deleted: [{ id: "e", title: "E", folder: "Old" }], failed: [] }));

    await expect(batchDelete({ folder: "Old" })).resolves.toEqual({
      deleted: [
        { id: "a", title: "A", folder: "Old" },
        { id: "e", title: "E", folder: "Old" },
      ],
      failed: ["B", "c", "D"],
    });

    expect(executeJxa).toHaveBeenCalledTimes(4);
    expect(scriptOf(0)).toContain(`findFolder("Old", 'Folder')`);
    expect(scriptOf(0)).toContain("folder.notes.id()");
    expect(constLiteralJson(scriptOf(1), "ids")).toEqual(["a", "b"]);
    expect(constLiteralJson(scriptOf(2), "ids")).toEqual(["c", "d"]);
    expect(constLiteralJson(scriptOf(3), "ids")).toEqual(["e"]);
    expect(scriptOf(3)).toContain("app.notes.byId(ids[i]).delete()");
  });

  it("should delete individual notes by title and track failures", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: false, error: "Note not found" });
    vi.mocked(executeJxa).mockResolvedValue("ok");

    await expect(batchDelete({ titles: ["Note 1", "Missing Note"] })).resolves.toEqual({
      deleted: [{ id: "1", title: "Note 1", folder: "Work" }],
      failed: ["Missing Note"],
    });
  });
});

describe("batchMove", () => {
  it("should throw if targetFolder missing", async () => {
    await expect(batchMove({ titles: ["Note"], targetFolder: "" })).rejects.toThrow(
      "targetFolder is required"
    );
  });

  it("should throw if both titles and sourceFolder provided", async () => {
    await expect(
      batchMove({ titles: ["Note"], sourceFolder: "Folder", targetFolder: "Archive" })
    ).rejects.toThrow("Specify either titles or sourceFolder, not both");
  });

  it("should throw if neither titles nor sourceFolder provided", async () => {
    await expect(batchMove({ targetFolder: "Archive" })).rejects.toThrow(
      "Specify either titles or sourceFolder"
    );
  });

  it("should resolve both folders once, then move by id in groups and keep finished groups", async () => {
    process.env.NOTES_FETCH_BATCH_SIZE = "1";
    const first = { id: "a", title: "A", folder: "Archive", fromFolder: "Temp" };
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(
        JSON.stringify({
          sourceName: "Temp",
          targetId: "folder-9",
          targetName: "Archive",
          ids: ["a", "b"],
          names: ["A", "B"],
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ moved: [first], failed: [] }))
      .mockRejectedValueOnce(new Error("JXA timed out"));

    await expect(batchMove({ sourceFolder: "Temp", targetFolder: "Archive" })).resolves.toEqual({
      moved: [first],
      failed: ["B"],
    });

    expect(executeJxa).toHaveBeenCalledTimes(3);
    expect(scriptOf(0)).toContain(`findFolder("Temp", 'Source folder')`);
    expect(scriptOf(0)).toContain(`findFolder("Archive", 'Target folder')`);
    for (const call of [1, 2]) {
      expect(scriptOf(call)).not.toContain("findFolder(");
      expect(scriptOf(call)).toContain(`app.folders.byId("folder-9")`);
    }
    expect(constLiteralJson(scriptOf(2), "ids")).toEqual(["b"]);
  });

  it("should move individual notes by title to the folder resolved once, and track failures", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: false, error: "Note not found" })
      .mockResolvedValueOnce({ success: true, note: { id: "2", title: "Note 2", folder: "Home" } });
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(JSON.stringify({ targetId: "folder-9" }))
      .mockResolvedValue(JSON.stringify({ toFolder: "Archive" }));

    await expect(
      batchMove({ titles: ["Note 1", "Missing Note", "Note 2"], targetFolder: "Archive" })
    ).resolves.toEqual({
      moved: [
        { id: "1", title: "Note 1", folder: "Archive", fromFolder: "Work" },
        { id: "2", title: "Note 2", folder: "Archive", fromFolder: "Home" },
      ],
      failed: ["Missing Note"],
    });

    expect(executeJxa).toHaveBeenCalledTimes(3);
    expect(scriptOf(0)).toContain(`findFolder("Archive", 'Target folder')`);
    for (const call of [1, 2]) {
      expect(scriptOf(call)).toContain(`const targetFolder = app.folders.byId("folder-9");`);
      expect(scriptOf(call)).not.toContain(`findFolder("Archive"`);
    }
  });

  it("should throw a missing or ambiguous target folder before moving anything", async () => {
    vi.mocked(executeJxa).mockRejectedValueOnce(
      new Error('JXA execution failed: Multiple folders match "Archive": iCloud/Archive, On My Mac/Archive.')
    );

    await expect(batchMove({ titles: ["Note 1", "Note 2"], targetFolder: "Archive" })).rejects.toThrow(
      "iCloud/Archive, On My Mac/Archive"
    );
    expect(executeJxa).toHaveBeenCalledTimes(1);
    expect(resolveNoteTitle).not.toHaveBeenCalled();
  });
});
