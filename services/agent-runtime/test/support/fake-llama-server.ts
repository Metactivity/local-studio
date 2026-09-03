// A scripted OpenAI-compatible llama-server: one reply per chat request, in
// order. Enough wire for the harness (streamed tool calls and text, usage
// chunk, /health, /v1/models, /v1/embeddings) and nothing else. Also the
// local DoD target: `bun test/support/fake-llama-server.ts` prints the env.

export type ScriptedReply = { toolCall: { name: string; args: Record<string, unknown> } } | { text: string };

export interface SeenRequest {
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

export interface FakeLlamaServer {
  url: string;
  seen: SeenRequest[];
  stop(): void;
}

const sse = (chunks: unknown[]): Response =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

function replyChunks(reply: ScriptedReply, index: number): unknown[] {
  const usage = { choices: [], usage: { prompt_tokens: 120 + index, completion_tokens: 12 } };
  if ("text" in reply) {
    return [
      { choices: [{ index: 0, delta: { role: "assistant", content: reply.text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      usage,
    ];
  }
  const id = `call_${index + 1}`;
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id, type: "function", function: { name: reply.toolCall.name, arguments: "" } }],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.toolCall.args) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    usage,
  ];
}

/** Default script: a bulky command (compaction), a hook-bypassing commit (gate), then the answer. */
export const DEFAULT_SCRIPT: ScriptedReply[] = [
  { toolCall: { name: "bash", args: { command: "seq 1 2000" } } },
  { toolCall: { name: "bash", args: { command: "git commit --no-verify -m wip" } } },
  { text: "Done: listed the numbers; the commit was blocked by ACE, so nothing was committed." },
];

export function startFakeLlamaServer(script: ScriptedReply[] = DEFAULT_SCRIPT, port = 0): FakeLlamaServer {
  const seen: SeenRequest[] = [];
  let replies = 0;
  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : null;
      seen.push({ path: url.pathname, auth: request.headers.get("authorization"), body });
      switch (url.pathname) {
        case "/health":
          return Response.json({ status: "ok" });
        case "/props":
          return Response.json({ build_info: "fake", model_path: "/models/fake.gguf", default_generation_settings: { n_ctx: 32768 } });
        case "/v1/models":
          return Response.json({ data: [{ id: "fake-qwen3.8" }, { id: "qwen3-embedding" }] });
        case "/v1/embeddings": {
          const input = (body?.input as unknown[]) ?? [];
          return Response.json({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })) });
        }
        case "/v1/chat/completions": {
          const reply = script[Math.min(replies, script.length - 1)] ?? { text: "" };
          return sse(replyChunks(reply, replies++));
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const server = startFakeLlamaServer(DEFAULT_SCRIPT, Number(process.env.PORT ?? 18080));
  console.log(`fake llama-server on ${server.url}`);
  console.log(`export ACE_CHAT_BASE_URL=${server.url} ACE_EMBED_BASE_URL=${server.url} ACE_API_KEY=fake ACE_CHAT_MODEL=fake-qwen3.8`);
}
