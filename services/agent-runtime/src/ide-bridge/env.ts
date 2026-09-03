// The execution environment of the harness tools (`read`, `edit`, `write`,
// …) with one rule on top of the disk (ADR-034 M6): a file that is open AND
// dirty in the IDE is read and written through the editor (`ide.readFile`,
// `ide.applyEdit`), never through the filesystem, so the user's unsaved work is
// the base of the edit and is never clobbered. Everything else is the plain
// NodeExecutionEnv; the IDE's file watcher picks disk writes up as before.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { err, type FileError, FileError as FileErrorClass, ok, type Result } from "@local-studio/harness";
import { NodeExecutionEnv } from "@local-studio/harness/node";
import { ideBridge, type IdeBridgeServer } from "./server";

export class IdeAwareExecutionEnv extends NodeExecutionEnv {
  readonly #bridge: IdeBridgeServer;

  constructor(options: { cwd: string }, bridge: IdeBridgeServer = ideBridge()) {
    super(options);
    this.#bridge = bridge;
  }

  /** The document uri when the IDE holds an unsaved buffer for `file`; null otherwise. */
  dirtyUri(file: string): string | null {
    const uri = pathToFileURL(path.resolve(this.cwd, file)).toString();
    return this.#bridge.context(this.cwd)?.dirty.includes(uri) ? uri : null;
  }

  override async readTextFile(file: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const uri = this.dirtyUri(file);
    if (uri === null) return super.readTextFile(file, abortSignal);
    try {
      return ok((await this.#bridge.action(this.cwd, "ide.readFile", { uri })).text);
    } catch (error) {
      return err(new FileErrorClass("unknown", `IDE read failed: ${error instanceof Error ? error.message : String(error)}`, file));
    }
  }

  override async writeFile(file: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    const uri = this.dirtyUri(file);
    if (uri === null || typeof content !== "string") return super.writeFile(file, content, abortSignal);
    try {
      const result = await this.#bridge.action(this.cwd, "ide.applyEdit", { edits: [{ uri, text: content }] });
      const failed = result.failed[0];
      return failed ? err(new FileErrorClass("unknown", `IDE edit failed: ${failed.reason}`, file)) : ok(undefined);
    } catch (error) {
      return err(new FileErrorClass("unknown", `IDE edit failed: ${error instanceof Error ? error.message : String(error)}`, file));
    }
  }
}
