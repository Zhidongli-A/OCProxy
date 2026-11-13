import type { Config } from "./types.ts";
import { resolveWorkingDirectory } from "./environment.ts";

/** OpenCode release whose captured harness + wire format we impersonate. */
export const DEFAULT_OPENCODE_VERSION = "2.2.6";

const DEFAULTS: Omit<Config, "workingDirectory"> = {
  host: "0.0.0.0",
  port: 8787,
  upstreamBaseUrl: "https://opencode.ai/inference/openai/v1",
  upstreamModelsUrl: "https://opencode.ai/inference/v1/models",
  upstreamApiKey: "public",
  upstreamProxy: undefined,
  opencodeVersion: DEFAULT_OPENCODE_VERSION,
  userAgent: `opencode/latest/${DEFAULT_OPENCODE_VERSION}/cli`,
  opencodeClient: "cli",
  opencodeProjectId: undefined,
  contextGuard: true,
  retryOn429: true,
  contextLimitOverrides: {},
  defaultMaxCompletionTokens: 32000,
  dryRun: false,
  modelCacheTtlMs: 10 * 60 * 1000,
  modelCacheErrorTtlMs: 30 * 1000,
  freeModelsOnly: true,
  includeUsage: true,
  requestTimeoutMs: 5 * 60 * 1000,
  extraFreeModels: [],
  sessionAffinity: "auto",
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

function bool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseLimitOverrides(
  value: string | undefined,
): Config["contextLimitOverrides"] {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Config["contextLimitOverrides"] = {};
    for (const [id, raw] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const source = raw as Record<string, unknown>;
      const entry: { context?: number; input?: number; output?: number } = {};
      for (const key of ["context", "input", "output"] as const) {
        const number = source[key];
        if (typeof number === "number" && Number.isFinite(number) && number > 0) {
          entry[key] = number;
        }
      }
      if (Object.keys(entry).length > 0) out[id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Build the runtime configuration from environment variables. An explicit
 * object (used by tests) overrides environment values.
 */
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

  const affinityRaw = str(
    env.SESSION_AFFINITY,
    DEFAULTS.sessionAffinity,
  ).toLowerCase();
  const sessionAffinity: Config["sessionAffinity"] =
    affinityRaw === "off" || affinityRaw === "random" ? affinityRaw : "auto";

  const opencodeVersion = str(
    env.OPENCODE_VERSION,
    DEFAULT_OPENCODE_VERSION,
  );
  const userAgent = str(
    env.OPENCODE_USER_AGENT,
    `opencode/latest/${opencodeVersion}/cli`,
  );

  const projectId = env.OPENCODE_PROJECT_ID?.trim();

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
    upstreamApiKey: str(env.UPSTREAM_API_KEY, DEFAULTS.upstreamApiKey),
    upstreamProxy: env.UPSTREAM_PROXY?.trim() || undefined,
    opencodeVersion,
    userAgent,
    opencodeClient: str(env.OPENCODE_CLIENT, DEFAULTS.opencodeClient),
    opencodeProjectId: projectId || undefined,
    workingDirectory: resolveWorkingDirectory(env.OPENCODE_WORKING_DIRECTORY),
    contextGuard: bool(env.CONTEXT_GUARD, DEFAULTS.contextGuard),
    retryOn429: bool(env.RETRY_ON_429, DEFAULTS.retryOn429),
    contextLimitOverrides: {
      ...DEFAULTS.contextLimitOverrides,
      ...parseLimitOverrides(env.CONTEXT_LIMIT_OVERRIDES),
    },
    defaultMaxCompletionTokens: int(
      env.OPENCODE_MAX_COMPLETION_TOKENS,
      DEFAULTS.defaultMaxCompletionTokens,
    ),
    dryRun: bool(env.UPSTREAM_DRY_RUN, DEFAULTS.dryRun),
    modelCacheTtlMs: int(env.MODEL_CACHE_TTL_MS, DEFAULTS.modelCacheTtlMs),
    modelCacheErrorTtlMs: int(
      env.MODEL_CACHE_ERROR_TTL_MS,
      DEFAULTS.modelCacheErrorTtlMs,
    ),
    freeModelsOnly: bool(env.FREE_MODELS_ONLY, DEFAULTS.freeModelsOnly),
    includeUsage: bool(env.UPSTREAM_INCLUDE_USAGE, DEFAULTS.includeUsage),
    requestTimeoutMs: int(
      env.REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
    ),
    extraFreeModels: csv(env.EXTRA_FREE_MODELS),
    sessionAffinity,
    logLevel,
  };

  return { ...config, ...overrides };
}
