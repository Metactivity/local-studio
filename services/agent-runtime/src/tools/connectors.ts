// Connector bridge: one tool per MCP tool of every enabled connector the session's
// model is granted, registered as `<connectorId>_<toolName>`. Calls go through the
// runtime's pooled MCP connections (/api/agent/connectors/call), so one stdio
// server serves every session. Registered only when at least one connector is
// enabled (the runtime's gate).
//
// Ported from pi-extensions/connectors.ts; names, descriptions and schemas unchanged.

import { Type } from "@earendil-works/pi-ai";
import { type HarnessTool, textResult, type ToolContext, type ToolResult, withTimeout } from "./context";

const INVENTORY_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

interface InventoryTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface InventoryConnector {
  id: string;
  name: string;
  tools: InventoryTool[];
  error?: string;
}

/** Render an MCP tools/call result (content blocks) as plain text. */
const renderMcpResult = (result: unknown): string => {
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown[] }).content)) {
    const blocks = (result as { content: Array<{ type?: string; text?: string }> }).content;
    return blocks.map((block) => (block.type === "text" && block.text ? block.text : JSON.stringify(block))).join("\n") || "(empty result)";
  }
  return JSON.stringify(result ?? null);
};

async function callConnectorTool(
  ctx: ToolContext,
  connectorId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const bounded = withTimeout(signal, CALL_TIMEOUT_MS);
  try {
    const response = await ctx.request("/api/agent/connectors/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connector_id: connectorId, tool, args, model_id: ctx.modelId }),
      signal: bounded.signal,
    });
    const payload = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (!response.ok || !payload.ok) {
      return textResult(`${connectorId}/${tool} failed: ${payload.error ?? response.status}`, { connectorId, tool, failed: true });
    }
    return textResult(renderMcpResult(payload.result), { connectorId, tool });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`${connectorId}/${tool} failed: ${message}`, { connectorId, tool, error: message, failed: true });
  } finally {
    bounded.done();
  }
}

export async function connectorTools(ctx: ToolContext): Promise<HarnessTool[]> {
  let inventory: InventoryConnector[] = [];
  try {
    const response = await ctx.request(`/api/agent/connectors/call?model_id=${encodeURIComponent(ctx.modelId)}`, {
      signal: AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
    });
    const payload = (await response.json()) as { connectors?: InventoryConnector[] };
    inventory = payload.connectors ?? [];
  } catch {
    // Inventory unavailable or no connectors — register nothing.
    return [];
  }

  return inventory.flatMap((connector) =>
    connector.tools.map(
      (tool): HarnessTool => ({
        name: `${connector.id.replace(/-/g, "_")}_${tool.name.replace(/[^A-Za-z0-9_]/g, "_")}`,
        label: `${connector.name}: ${tool.name}`,
        description: tool.description || `${tool.name} via the ${connector.name} connector`,
        // MCP tools carry their own JSON Schema; pass it through untyped.
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object", properties: {} }),
        execute: (_id, params, signal) => callConnectorTool(ctx, connector.id, tool.name, (params ?? {}) as Record<string, unknown>, signal),
      }),
    ),
  );
}
