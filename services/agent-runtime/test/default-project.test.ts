import { describe, expect, test } from "bun:test";
import { defaultProjectId } from "../../../shared/agent/default-project";
import { CHATS_PROJECT_ID } from "../../../shared/agent/project-ids";

const chats = { id: CHATS_PROJECT_ID, exists: true };
const gone = { id: "p-gone", exists: false };
const real = { id: "p-real", exists: true };

describe("defaultProjectId (MET-933)", () => {
  test("keeps a selected real project, never the Chats data dir", () => {
    expect(defaultProjectId([chats, gone, real], "p-real")).toBe("p-real");
    expect(defaultProjectId([chats, gone, real], CHATS_PROJECT_ID)).toBe("p-real");
    expect(defaultProjectId([chats, gone, real], "unknown")).toBe("p-real");
    expect(defaultProjectId([chats, gone, real], null)).toBe("p-real");
  });

  test("falls back to the first registered folder, a missing one last, and to null without any", () => {
    expect(defaultProjectId([chats, gone], null)).toBe("p-gone");
    expect(defaultProjectId([chats], null)).toBeNull();
    expect(defaultProjectId([], "p-real")).toBeNull();
  });
});
