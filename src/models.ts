/**
 * Free-model catalog.
 *
 * The Zen catalog (`/v1/models`) is the source of truth and is always read
 * live: nothing is cached and no model metadata is hardcoded. Every entry
 * carrying a zero input AND output price is considered free; everything else
 * is dropped so paid models are never advertised or served.
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
  source: "live" | "unavailable";
  models: number;
  updatedAt: number;
  lastError?: string;
}

export interface ModelRegistryOptions {
  config: Config;
  upstream?: UpstreamClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Live free-model catalog. Lookups always hit `/v1/models`; the last result is
 * kept only to describe catalog status on `/health` and the dashboard.
 */
export class ModelRegistry {
  readonly #upstream: UpstreamClient;
  readonly #now: () => number;

  #snapshot: ModelInfo[] = [];
  #updatedAt = 0;
  #lastError: string | undefined;
  #inflight: Promise<ModelInfo[]> | undefined;

  constructor(options: ModelRegistryOptions) {
    this.#upstream =
      options.upstream ??
      new UpstreamClient(options.config, options.fetchImpl ?? fetch);
    this.#now = options.now ?? Date.now;
  }

  get status(): CatalogStatus {
    return {
      source:
        this.#snapshot.length > 0 && !this.#lastError ? "live" : "unavailable",
      models: this.#snapshot.length,
      updatedAt: this.#updatedAt,
      lastError: this.#lastError,
    };
  }

  /**
   * Fetch the free catalog from upstream. Concurrent callers share one
   * in-flight request; nothing is reused after it settles.
   */
  async getModels(): Promise<ModelInfo[]> {
    if (this.#inflight) return this.#inflight;
    const pending = this.#fetch().finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = pending;
    return pending;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const normalized = normalizeModelId(id);
    const models = await this.getModels();
    return models.find(
      (model) => model.id.toLowerCase() === normalized.toLowerCase(),
    );
  }

  /**
   * Resolve a downstream model name to a live free catalog entry, applying
   * provider prefix normalisation. Throws 503 when the catalog cannot be read
   * and 404 when the model is unknown or paid.
   */
  async resolve(model: string): Promise<ModelInfo> {
    const normalized = normalizeModelId(model).toLowerCase();
    const models = await this.getModels();
    const found = models.find(
      (entry) => entry.id.toLowerCase() === normalized,
    );
    if (found) return found;

    throw modelNotFound(
      `Model '${model}' is not a free OpenCode Zen model. ` +
        `Available free models: ${models.map((entry) => entry.id).join(", ")}`,
    );
  }

  async #fetch(): Promise<ModelInfo[]> {
    try {
      const payload = await this.#upstream.fetchCatalog();
      const rawModels = extractRawModels(payload);
      if (rawModels.length === 0) {
        throw new Error("catalog response contained no models");
      }

      // Preserve the order returned by the catalog, de-duplicated by id.
      const seen = new Set<string>();
      const unique: ModelInfo[] = [];
      for (const raw of rawModels) {
        const model = toModelInfo(raw);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        unique.push(model);
      }
      if (unique.length === 0) {
        throw new Error("catalog contained no free chat models");
      }

      this.#snapshot = unique;
      this.#updatedAt = this.#now();
      this.#lastError = undefined;
      return unique;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#updatedAt = this.#now();
      throw new HttpError(
        503,
        `Free model catalog is unavailable: ${this.#lastError}`,
        "catalog_unavailable",
        "upstream_error",
      );
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
