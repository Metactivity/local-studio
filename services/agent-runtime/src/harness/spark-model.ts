// A ModelProfile turned into the pi-ai objects the harness streams with: the
// Model carries the sampling defaults and the effort map (never `high`), the
// Models registry supplies `streamSimple` for user turns and `completeSimple`
// for history summaries — one OpenAI-compatible provider, one bearer key.

import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelProfile } from "./model-profile";

export const HARNESS_PROVIDER_ID = "spark";

export interface HarnessModelOptions {
  /** The served model id (what llama-server reports on /v1/models). */
  id: string;
  /** Runtime origin, e.g. `http://127.0.0.1:8000`; `/v1` is appended. */
  baseUrl: string;
  profile: ModelProfile;
  name?: string;
}

/** pi thinking levels → the profile's effort names; `off` sends nothing. */
export function profileThinkingLevelMap(profile: ModelProfile): ThinkingLevelMap {
  return {
    off: null,
    minimal: profile.reasoning.fromThinkingLevel("minimal"),
    low: profile.reasoning.fromThinkingLevel("low"),
    medium: profile.reasoning.fromThinkingLevel("medium"),
    high: profile.reasoning.fromThinkingLevel("high"),
    xhigh: profile.reasoning.fromThinkingLevel("xhigh"),
    max: profile.reasoning.fromThinkingLevel("max"),
  };
}

export function createHarnessModel(options: HarnessModelOptions): Model<"openai-completions"> {
  const { profile } = options;
  return {
    id: options.id,
    name: options.name ?? options.id,
    api: "openai-completions",
    provider: HARNESS_PROVIDER_ID,
    baseUrl: `${options.baseUrl.replace(/\/+$/, "")}/v1`,
    reasoning: true,
    thinkingLevelMap: profileThinkingLevelMap(profile),
    input: profile.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    samplingParams: { ...profile.sampling },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      // The effort travels in chat_template_kwargs, never as a top-level reasoning_effort.
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "chat-template",
      chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort", omitWhenOff: true } },
    },
  };
}

/** The registry behind `streamSimple` (user turns) and `completeSimple` (compaction summaries). */
export function createHarnessModels(model: Model<Api>, apiKey: string | undefined): Models {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Spark llama-server",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: "Spark API key",
          resolve: async () => ({ auth: { apiKey: apiKey ?? "" }, source: "harness" }),
        },
      },
      models: [model],
      api: openaiCompletions,
    }),
  );
  return models;
}
