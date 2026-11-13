#!/usr/bin/env node
/**
 * npm/npx launcher: the relay itself must run under Bun (TLS/HTTP fingerprint),
 * so this wrapper only locates Bun and forwards stdio.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "index.ts",
);

const isWindows = process.platform === "win32";
// Go through the shell so Windows resolves bun.cmd and paths are quoted once.
const command = isWindows ? `bun "${entry}"` : `bun '${entry.replace(/'/g, "'\\''")}'`;
const child = spawn(command, { stdio: "inherit", shell: true });

child.on("error", (error) => {
  console.error(
    `[OCProxy] failed to start Bun: ${error.message}\n` +
      "Install Bun (https://bun.sh) and make sure `bun` is on PATH.",
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
