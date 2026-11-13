/**
 * Free-model catalog.
 *
 * The Zen catalog (`/v1/models`) is the source of truth. Every entry carrying a
 * zero input AND output price is considered free; everything else is dropped
 * so paid models are never advertised or served. The catalog is fetched live
 * and cached; on failure the last successful in-memory snapshot is kept. No
 * model metadata is hardcoded in this project.
 */

import type { Config, ModelInfo } from "./types.ts";
import { HttpError, modelNotFound } from "./errors.ts";
import { UpstreamClient } from "./upstream.ts";

interface RawModel {
  id?: string;
  name?: string;
  created?: number;
  owned_by?: string;
  type?: string;
  description?: string;
  capabilities?: {
    tools?: { supported?: boolean };
    reasoning?: { supported?: boolean; effort?: string[] };
    structured_output?: boolean | { supported?: boolean };
  };
  modalities?: { input?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    text?: {
      input?: { price?: number };
      output?: { price?: number };
    };
  };
  api?: Record<string, { base_url?: string } | undefined>;
  [key: string]: unknown;
}

/** Zen API surfaces this relay can speak through the Chat Completions upstream. */
const SUPPORTED_APIS = new Set([
  "chat-completions",
  "responses",
  "messages",
  "generate-content",
]);

export function isFreeRawModel(raw: RawModel): boolean {
  if (raw.type && raw.type !== "chat") return false;

  const inputPrice = raw.cost?.text?.input?.price;
  const outputPrice = raw.cost?.text?.output?.price;
  if (typeof inputPrice === "number" && typeof outputPrice === "number") {
    return inputPrice === 0 && outputPrice === 0;
  }

  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return false;
  return /-free$/i.test(id);
}

export function toModelInfo(raw: RawModel): ModelInfo | undefined {
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
  if (!isFreeRawModel(raw)) return undefined;

  const apiKeys = raw.api && typeof raw.api === "object" ? Object.keys(raw.api) : [];
  const api = apiKeys.find((key) => SUPPORTED_APIS.has(key));
  // Drop entries whose only API surface is not relayable.
  if (apiKeys.length > 0 && !api) return undefined;

  const inputModalities = raw.modalities?.input ?? [];
  const structured =
    raw.capabilities?.structured_output === true ||
    (typeof raw.capabilities?.structured_output === "object" &&
      raw.capabilities?.structured_output !== null);

  return {
    id: raw.id,
    name:
      typeof raw.name === "string" && raw.name
        ? raw.name
        : raw.id,
    created:
      typeof raw.created === "number" ? raw.created : Math.floor(Date.now() / 1000),
    ownedBy:
      typeof raw.owned_by === "string" && raw.owned_by
        ? raw.owned_by
        : "opencode",
    description: typeof raw.description === "string" ? raw.description : undefined,
    contextLength: raw.limit?.context,
    inputLength: raw.limit?.input,
    maxOutputTokens: raw.limit?.output,
    capabilities: {
      tools: Boolean(raw.capabilities?.tools?.supported),
      reasoning: Boolean(raw.capabilities?.reasoning?.supported),
      vision: inputModalities.some((modality) =>
        /^(image|video|audio)\//.test(modality),
      ),
      structuredOutput: Boolean(structured),
    },
    reasoningEfforts: raw.capabilities?.reasoning?.effort,
    api: api ?? "chat-completions",
    free: true,
    raw,
  };
}

export interface CatalogStatus {
  source: "live" | "stale" | "unavailable";
  models: number;
  updatedAt: number;
  lastError?: string;
}

export interface ModelRegistryOptions {
  config: Config;
  upstream?: UpstreamClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Never touch the network; the catalog stays empty. */
  offline?: boolean;
}

export class ModelRegistry {
  readonly config: Config;
  readonly #upstream: UpstreamClient;
  readonly #now: () => number;
  readonly #offline: boolean;

  #models: ModelInfo[] = [];
  #byId = new Map<string, ModelInfo>();
  #updatedAt = 0;
  #fetchedOnce = false;
  #lastError: string | undefined;
  #inflight: Promise<ModelInfo[]> | undefined;

  constructor(options: ModelRegistryOptions) {
    this.config = options.config;
    this.#upstream =
      options.upstream ??
      new UpstreamClient(options.config, options.fetchImpl ?? fetch);
    this.#now = options.now ?? Date.now;
    this.#offline = options.offline ?? false;
  }

  get status(): CatalogStatus {
    return {
      source:
        this.#models.length === 0
          ? "unavailable"
          : this.#lastError
            ? "stale"
            : "live",
      models: this.#models.length,
      updatedAt: this.#updatedAt,
      lastError: this.#lastError,
    };
  }

  /** Return the cached free catalog, refreshing it when stale. */
  async getModels(force = false): Promise<ModelInfo[]> {
    const age = this.#now() - this.#updatedAt;
    const ttl = this.#lastError
      ? this.config.modelCacheErrorTtlMs
      : this.config.modelCacheTtlMs;
    if (!force && this.#fetchedOnce && age < ttl) {
      return this.#applyOverrides(this.#models);
    }

    if (this.#inflight) return this.#applyOverrides(await this.#inflight);

    this.#inflight = this.#refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#applyOverrides(await this.#inflight);
  }

  #applyOverrides(models: ModelInfo[]): ModelInfo[] {
    if (Object.keys(this.config.contextLimitOverrides).length === 0) {
      return models;
    }
    return models.map((model) => this.#applyOverride(model));
  }

  #applyOverride(model: ModelInfo): ModelInfo {
    const override = this.config.contextLimitOverrides[model.id];
    if (!override) return model;
    return {
      ...model,
      contextLength: override.context ?? model.contextLength,
      inputLength: override.input ?? model.inputLength,
      maxOutputTokens: override.output ?? model.maxOutputTokens,
    };
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const normalized = normalizeModelId(id);
    const models = await this.getModels();
    const found = this.#byId.get(normalized);
    if (found) return this.#applyOverride(found);
    return models.find((model) => model.id.toLowerCase() === normalized.toLowerCase());
  }

  /**
   * Resolve a downstream model name to a free catalog entry, applying provider
   * prefix normalisation. Throws 503 when the live catalog is unavailable and
   * 404 when the model is unknown or paid.
   */
  async resolve(model: string): Promise<ModelInfo> {
    const normalized = normalizeModelId(model);
    const found = await this.getModel(normalized);
    if (found) return found;

    const available = (await this.getModels()).map((entry) => entry.id);
    if (available.length === 0) {
      throw new HttpError(
        503,
        "Free model catalog is unavailable. Check network access to the upstream models endpoint.",
        "catalog_unavailable",
        "upstream_error",
      );
    }
    throw modelNotFound(
      `Model '${model}' is not a free OpenCode Zen model. ` +
        `Available free models: ${available.join(", ")}`,
    );
  }

  async #refresh(): Promise<ModelInfo[]> {
    if (this.#offline) {
      this.#fetchedOnce = true;
      this.#updatedAt = this.#now();
      this.#lastError = undefined;
      return this.#models;
    }
    try {
      const payload = await this.#upstream.fetchCatalog();
      const rawModels = extractRawModels(payload);
      if (rawModels.length === 0) {
        throw new Error("catalog response contained no models");
      }
      const free = rawModels
        .map((raw) => toModelInfo(raw))
        .filter((model): model is ModelInfo => Boolean(model));

      // Preserve the order returned by the catalog, de-duplicated by id.
      const seen = new Set<string>();
      const unique = free.filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });

      for (const extra of this.config.extraFreeModels) {
        if (extra === "*" || seen.has(extra)) continue;
        // Runtime allow-list entry: no metadata is hardcoded.
        unique.push({
          id: extra,
          name: extra,
          created: Math.floor(this.#now() / 1000),
          ownedBy: "opencode",
          capabilities: {
            tools: true,
            reasoning: true,
            vision: false,
            structuredOutput: false,
          },
          api: "chat-completions",
          free: true,
        });
        seen.add(extra);
      }

      if (unique.length === 0) {
        throw new Error("catalog contained no free chat models");
      }

      this.#models = unique;
      this.#byId = new Map(unique.map((model) => [model.id, model]));
      this.#updatedAt = this.#now();
      this.#fetchedOnce = true;
      this.#lastError = undefined;
      return unique;
    } catch (error) {
      this.#lastError = (error as Error).message;
      this.#fetchedOnce = true;
      this.#updatedAt = this.#now();
      return this.#models;
    }
  }
}

export function extractRawModels(payload: unknown): RawModel[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as RawModel[];
  if (typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const data = obj.data ?? obj.models;
  if (Array.isArray(data)) return data as RawModel[];
  return [];
}

/** Strip common provider prefixes so `openai/<id>` style names resolve too. */
export function normalizeModelId(model: string): string {
  let id = model.trim();
  if (!id) return id;
  // Gemini clients address models as "models/<id>".
  if (id.startsWith("models/")) id = id.slice("models/".length);
  // opencode/<id>, opencode-zen/<id>, zen/<id>, openai/<id>, ...
  const slash = id.indexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  return id;
}
