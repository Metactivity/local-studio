import { describe, expect, test } from "bun:test";
import { MODEL_PROFILES, QWEN38_RVN_PROFILE } from "../src/harness/model-profile";
import { createHarnessModel, profileThinkingLevelMap } from "../src/harness/spark-model";

describe("profile → pi-ai model", () => {
  test("sampling rides on the model, the effort map never yields high, off sends nothing", () => {
    for (const profile of MODEL_PROFILES) {
      const model = createHarnessModel({ id: "served", baseUrl: "http://127.0.0.1:8000/", profile });
      expect(model.samplingParams).toEqual(profile.sampling);
      expect(model.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(model.contextWindow).toBe(profile.contextWindow);
      const map = profileThinkingLevelMap(profile);
      expect(map.off).toBeNull();
      expect(Object.values(map)).not.toContain("high");
      expect(model.compat).toMatchObject({
        thinkingFormat: "chat-template",
        supportsReasoningEffort: false,
        chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort", omitWhenOff: true } },
      });
    }
    expect(profileThinkingLevelMap(QWEN38_RVN_PROFILE)).toMatchObject({ high: "medium", max: "xhigh", minimal: "low" });
  });
});
