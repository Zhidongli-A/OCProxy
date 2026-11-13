/**
 * OpenCode project identity helpers.
 *
 * OpenCode 2 sends `x-opencode-project` as `sha1("directory:" + dir)` outside a
 * git remote (packages/core/src/project.ts). This module reproduces that and
 * resolves the working directory used for it.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** sha1('directory:<dir>') — OpenCode 2's project id. */
export function computeProjectId(directory: string): string {
  return createHash("sha1").update(`directory:${directory}`).digest("hex");
}

/** Resolve the configured directory to an absolute path. */
export function resolveWorkingDirectory(
  directory: string | undefined,
): string {
  const value = directory?.trim();
  return resolve(value && value.length > 0 ? value : process.cwd());
}
