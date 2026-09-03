import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessStoreRoot } from "./data-dir";
import { isRecord } from "../../../shared/agent/guards";

/** Flatten a pi message `content` field to its plain text. Shared with the goal
 *  driver, which reads assistant text off the live event stream rather than the
 *  transcript so it only ever sees the turn that just settled. */
export function assistantMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

export type LastAssistantResult = {
  text: string;
  error: string | null;
};

export function lastAssistantResultFromJsonl(raw: string): LastAssistantResult {
  let text = "";
  let error: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant") continue;
    const messageText = assistantMessageText(entry.message.content).trim();
    if (messageText) {
      text = messageText;
      error = null;
      continue;
    }
    if (typeof entry.message.errorMessage === "string" && entry.message.errorMessage.trim()) {
      error = entry.message.errorMessage.trim();
    }
  }
  return { text, error };
}

/** The transcript is `sessions.db`: the session's mutations, oldest first, each
 *  wrapping one entry in the vocabulary pi wrote — so the JSONL reader applies
 *  unchanged once the entries are laid out one per line. */
function harnessTranscript(sessionId: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(harnessStoreRoot(), "sessions.db"), { readOnly: true });
    const rows = db
      .prepare("SELECT json FROM mutations WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as Array<{ json: string }>;
    return rows.map((row) => JSON.stringify((JSON.parse(row.json) as { entry?: unknown }).entry ?? null)).join("\n");
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The last assistant text (and any trailing error) a session has written so far. */
export function lastAssistantResult(piSessionId: string): LastAssistantResult {
  const transcript = harnessTranscript(piSessionId);
  return transcript === null ? { text: "", error: null } : lastAssistantResultFromJsonl(transcript);
}
