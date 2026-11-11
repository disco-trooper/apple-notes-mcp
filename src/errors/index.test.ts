import { describe, it, expect } from "vitest";
import { DuplicateNoteError } from "./index.js";

describe("DuplicateNoteError", () => {
  it("lists every candidate as an id: reference with folder and creation date", () => {
    const error = new DuplicateNoteError("Note", [
      { id: "id-1", folder: "Work", title: "Note", created: "2026-01-09T10:00:00.000Z" },
      { id: "id-2", folder: "Personal", title: "Note", created: "2026-01-09T11:00:00.000Z" },
    ]);

    expect(error.message).toBe(
      'Multiple notes found with title "Note". Use ID prefix:\n' +
        "  - id:id-1 (Work, created: 2026-01-09)\n" +
        "  - id:id-2 (Personal, created: 2026-01-09)"
    );
  });
});
