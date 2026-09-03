// `ace/*` over the bridge (ADR-034 §2.3): the extension's AcePort served by the
// runtime's single NativeService. Params come from the socket — checked here,
// never trusted. Results are what NativeService returns; a missing ACE is a
// JSON-RPC error the extension folds into its degraded state.

import type { AceBridgeMethods } from "@metactivity/protocol";
import { BRIDGE_UNAVAILABLE, JSON_RPC_INVALID_PARAMS } from "@metactivity/protocol";
import { startedAceService } from "../harness-runtime";
import { resolveAllowedWorkspace } from "../projects-store";

export class AceEndpointError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new AceEndpointError(JSON_RPC_INVALID_PARAMS, `"${key}" must be a non-empty string`);
  return value;
}

/** The folder the extension names must be an allowed workspace, like every folder-addressed route. */
function workspace(params: Record<string, unknown>): string {
  try {
    return resolveAllowedWorkspace(requireString(params, "cwd"));
  } catch (error) {
    if (error instanceof AceEndpointError) throw error;
    throw new AceEndpointError(JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : "cwd is not allowed");
  }
}

async function requireAce() {
  const ace = await startedAceService();
  if (!ace) throw new AceEndpointError(BRIDGE_UNAVAILABLE, "ACE is not configured on this runtime");
  return ace;
}

export async function serveAceRequest(method: string, rawParams: unknown): Promise<unknown> {
  const params = isRecord(rawParams) ? rawParams : {};
  switch (method as keyof AceBridgeMethods) {
    case "ace/getStatus":
      return (await startedAceService())?.getStatus() ?? null;
    case "ace/prepareTask": {
      const ace = await requireAce();
      const excluded = Array.isArray(params.excludedSources) ? params.excludedSources.filter((s): s is string => typeof s === "string") : [];
      return ace.prepareTask(requireString(params, "task"), workspace(params), params.allowExploration === true, params.forceExploration === true, excluded);
    }
    case "ace/retrieveRelevantContext":
      return (await requireAce()).retrieveContext(requireString(params, "task"), workspace(params));
    case "ace/listProposals":
      return (await requireAce()).listProposals(workspace(params), typeof params.status === "string" ? params.status : "pending");
    case "ace/resolveProposal": {
      const ace = await requireAce();
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) throw new AceEndpointError(JSON_RPC_INVALID_PARAMS, '"id" must be a positive integer');
      if (params.verdict !== "accept" && params.verdict !== "reject") throw new AceEndpointError(JSON_RPC_INVALID_PARAMS, '"verdict" must be "accept" or "reject"');
      const edited = typeof params.editedContent === "string" && params.editedContent.trim() ? params.editedContent : undefined;
      return ace.resolveProposal(workspace(params), id, params.verdict, edited, params.scope === "global" ? "global" : "project");
    }
    case "ace/observeAgentEvent": {
      if (!isRecord(params.event)) throw new AceEndpointError(JSON_RPC_INVALID_PARAMS, '"event" must be an object');
      (await requireAce()).observeAgentEvent(params.event, workspace(params));
      return null;
    }
    default:
      throw new AceEndpointError(-32601, `unknown method ${method}`);
  }
}
