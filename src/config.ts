/**
 * Runtime configuration.
 *
 * Only the four deployment knobs below exist. Request headers, the free-model
 * filter, the local token estimate, the live (never cached) catalog and the
 * one-shot 429 retry are fixed behaviour, not settings.
 */

import type { Config } from "./types.ts";

const DEFAULTS: Config = {
  host: "0.0.0.0",
  port: 8787,
  upstreamBaseUrl: "https://opencode.ai/inference/openai/v1",
  upstreamModelsUrl: "https://opencode.ai/inference/v1/models",
  upstreamProxy: undefined,
  requestTimeoutMs: 5 * 60 * 1000,
  logLevel: "info",
};

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Build the runtime configuration from environment variables. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Config> = {},
): Config {
  const logLevelRaw = str(env.LOG_LEVEL, DEFAULTS.logLevel).toLowerCase();
  const logLevel: Config["logLevel"] =
    logLevelRaw === "debug" ||
    logLevelRaw === "warn" ||
    logLevelRaw === "error"
      ? logLevelRaw
      : "info";

  const config: Config = {
    host: str(env.HOST, DEFAULTS.host),
    port: int(env.PORT, DEFAULTS.port),
    upstreamBaseUrl: str(env.UPSTREAM_BASE_URL, DEFAULTS.upstreamBaseUrl).replace(
      /\/+$/,
      "",
    ),
    upstreamModelsUrl: str(
      env.UPSTREAM_MODELS_URL,
      DEFAULTS.upstreamModelsUrl,
    ),
    upstreamProxy: env.UPSTREAM_PROXY?.trim() || undefined,
    requestTimeoutMs: int(
      env.REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
    ),
    logLevel,
  };

  return { ...config, ...overrides };
}
