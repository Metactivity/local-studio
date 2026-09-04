// The dispatcher against a stubbed chrome.*: the read-only refusal, the
// allow-list, and one read that goes through scripting.executeScript.

import { beforeAll, describe, expect, test } from "bun:test";
import { dispatch, METHODS, READ_ONLY } from "../src/rpc";

const tab = { id: 7, url: "https://example.test/", title: "Example", active: true, windowId: 1 };
const calls: string[] = [];

beforeAll(() => {
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      query: async () => [tab],
      remove: async (id: number) => void calls.push(`remove:${id}`),
    },
    scripting: {
      executeScript: async ({
        func,
        args,
      }: {
        func: (...a: unknown[]) => unknown;
        args: unknown[];
      }) => {
        calls.push(`inject:${func.name}`);
        return [{ result: `ran ${func.name}(${args.join(",")})` }];
      },
    },
  };
});

describe("browser bridge extension dispatcher", () => {
  test("read-only refuses eval/click/fill with -32002, allows reads; unknown methods are -32601", async () => {
    await expect(dispatch("browser.click", { selector: "a" }, true)).rejects.toMatchObject({
      code: READ_ONLY,
      message: "read-only mode",
    });
    await expect(
      dispatch("browser.fill", { selector: "a", value: "x" }, true),
    ).rejects.toMatchObject({ code: READ_ONLY });
    await expect(dispatch("browser.eval", { expression: "1" }, true)).rejects.toMatchObject({
      code: READ_ONLY,
    });
    expect(await dispatch("browser.url", {}, true)).toEqual({ url: tab.url, title: tab.title });
    expect(await dispatch("browser.text", { selector: "main" }, true)).toEqual({
      text: "ran pageText(main)",
    });
    expect(await dispatch("browser.click", { selector: "a" }, false)).toBe("ran pageClick(a)");
    await expect(dispatch("chrome.debugger.attach", {}, false)).rejects.toMatchObject({
      code: -32601,
    });
    await expect(dispatch("browser.tabs.close", { id: "x" }, false)).rejects.toMatchObject({
      code: -32602,
    });
    expect(await dispatch("browser.tabs.close", { id: 7 }, false)).toEqual({ ok: true });
    expect(calls).toEqual(["inject:pageText", "inject:pageClick", "remove:7"]);
    expect(METHODS).toHaveLength(13);
  });
});
