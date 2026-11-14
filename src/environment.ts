/**
 * OpenCode project identity helpers.
 *
 * OpenCode 2 sends `x-opencode-project` as `sha1("directory:" + dir)` outside a
 * git remote (packages/core/src/project.ts). The directory is the relay
 * process's working directory; it is never configurable.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** sha1('directory:<dir>') — OpenCode 2's project id. */
export function computeProjectId(directory: string): string {
  return createHash("sha1").update(`directory:${directory}`).digest("hex");
}

let cachedDirectory: string | undefined;

/** Absolute working directory named in the project id and `<env>` block. */
export function workingDirectory(): string {
  cachedDirectory ??= resolve(process.cwd());
  return cachedDirectory;
}
