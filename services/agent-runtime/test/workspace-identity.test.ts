import { describe, expect, test } from "bun:test";
import { sessionIdentity } from "../../../shared/agent/workspace-identity";

describe("sessionIdentity", () => {
  test("the X-Tuum headers win over the body and the folder is percent-decoded", () => {
    const headers = new Headers({
      "X-Tuum-Session": "tab-42",
      "X-Tuum-Folder": encodeURIComponent("/home/joris/projets/été"),
    });
    expect(sessionIdentity(headers, { sessionId: "default", cwd: "/elsewhere" })).toEqual({
      sessionId: "tab-42",
      cwd: "/home/joris/projets/été",
    });
  });

  test("without headers the body/query values apply, with the runtime defaults", () => {
    expect(sessionIdentity(new Headers(), { sessionId: " ", cwd: " /home/joris/p " })).toEqual({
      sessionId: "default",
      cwd: "/home/joris/p",
    });
    expect(sessionIdentity(new Headers(), {})).toEqual({ sessionId: "default", cwd: undefined });
  });
});
