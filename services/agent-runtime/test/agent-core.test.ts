import { describe, expect, test } from "bun:test";
import { agentCore } from "../src/agent-core";

describe("agentCore", () => {
  test("the deprecated pi value falls back to the harness with a warning", () => {
    const warnings: string[] = [];
    expect(agentCore({ LOCAL_STUDIO_AGENT_CORE: "pi" }, (message) => warnings.push(message))).toBe("harness");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("LOCAL_STUDIO_AGENT_CORE=pi is deprecated");
  });

  test("unset or harness stays silent", () => {
    const warnings: string[] = [];
    expect(agentCore({}, (message) => warnings.push(message))).toBe("harness");
    expect(agentCore({ LOCAL_STUDIO_AGENT_CORE: "harness" }, (message) => warnings.push(message))).toBe("harness");
    expect(warnings).toEqual([]);
  });
});
