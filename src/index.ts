/**
 * Entry point: `bun src/index.ts` (or `bun run start`).
 */

import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const app = createApp({ config });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0,
  fetch: app.handler,
});

const displayHost =
  config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;

console.log("");
console.log("  OCProxy");
console.log(`  listening   http://${displayHost}:${server.port}`);
console.log(`  upstream    ${config.upstreamBaseUrl}`);
console.log(`  models      ${config.upstreamModelsUrl}`);
console.log(`  free only   ${config.freeModelsOnly}`);
console.log(`  auth        ignored (upstream uses shared "public" key)`);
console.log("");

// Warm the free-model catalog in the background so /v1/models is ready.
void app.models.getModels().then(
  (models) => {
    console.log(
      `[OCProxy] catalog ready: ${models.length} free models ` +
        `(${models.map((model) => model.id).join(", ")})`,
    );
  },
  (error: unknown) => {
    console.warn(
      `[OCProxy] catalog warm-up failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  },
);

const shutdown = (): void => {
  console.log("\n[OCProxy] shutting down");
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
