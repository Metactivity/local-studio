// One workspace identity per call (ADR-034 §2.5): Local Studio project =
// `?folder=` of the IDE iframe = harness cwd = ACE projectHash = bridge session
// key. It travels as headers — set by the frontend and the Next proxy today, by
// the IDE bridge handshake from M5 — and falls back to the body/query fields a
// bare client still sends. Header values are ByteStrings, so the folder is
// percent-encoded on the wire (paths are not always Latin-1).

export const TUUM_SESSION_HEADER = "x-tuum-session";
export const TUUM_FOLDER_HEADER = "x-tuum-folder";

export type SessionIdentity = { sessionId: string; cwd: string | undefined };

export function sessionIdentity(
  headers: Headers,
  fallback: { sessionId?: string | null; cwd?: string | null },
): SessionIdentity {
  const session = headers.get(TUUM_SESSION_HEADER)?.trim();
  const folder = headers.get(TUUM_FOLDER_HEADER)?.trim();
  return {
    sessionId: session || fallback.sessionId?.trim() || "default",
    cwd: (folder ? decodeFolder(folder) : undefined) ?? (fallback.cwd?.trim() || undefined),
  };
}

function decodeFolder(value: string): string | undefined {
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}

/** The headers a client sets on a call that starts or resumes a runtime session. */
export function workspaceIdentityHeaders(identity: {
  sessionId: string;
  cwd?: string | null;
}): Record<string, string> {
  const cwd = identity.cwd?.trim();
  return {
    [TUUM_SESSION_HEADER]: identity.sessionId,
    ...(cwd ? { [TUUM_FOLDER_HEADER]: encodeURIComponent(cwd) } : {}),
  };
}
