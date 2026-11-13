/**
 * OpenCode Zen upstream client.
 *
 * Only one wire format is ever sent upstream: OpenAI Chat Completions. The
 * relay forces `stream: true` on every request (the requirement is that the
 * upstream is always consumed as SSE), regardless of what the downstream
 * client asked for. Non-streaming downstream requests are reconstituted from
 * the event stream by the adapters.
 */

import type { ChatRequest, Config, UpstreamEvent, Usage } from "./types.ts";
import {
  buildUpstreamHeaders,
  generateRequestId,
  type UpstreamIdentity,
} from "./identity.ts";
import { parseSSE } from "./sse.ts";

export class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly retryAfterSeconds?: number;
  readonly logId?: string;
  readonly raw?: unknown;

  constructor(opts: {
    status: number;
    message: string;
    code?: string;
    type?: string;
    retryAfterSeconds?: number;
    logId?: string;
    raw?: unknown;
  }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.code = opts.code ?? "upstream_error";
    this.type = opts.type ?? "upstream_error";
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.logId = opts.logId;
    this.raw = opts.raw;
  }
}

/** Fields accepted by Zen's OpenAI-compatible free models. */
const FORWARDABLE_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "user",
] as const;

export function buildUpstreamBody(
  request: ChatRequest,
  config: Config,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    // Requirement: upstream is ALWAYS streamed.
    stream: true,
  };

  for (const field of FORWARDABLE_FIELDS) {
    const value = request[field];
    if (value !== undefined && value !== null) body[field] = value;
  }

  if (config.includeUsage) {
    body.stream_options = { include_usage: true };
  }

  // OpenCode always sends a real max_completion_tokens (32000 by default).
  // Add it when the caller left both token limits unspecified so the wire
  // shape matches the official CLI.
  if (
    config.defaultMaxCompletionTokens > 0 &&
    body.max_tokens === undefined &&
    body.max_completion_tokens === undefined
  ) {
    body.max_completion_tokens = config.defaultMaxCompletionTokens;
  }

  // Some thinking-capable models expect `thinking`/`reasoning` blocks; pass
  // them through only when the caller supplied them explicitly.
  if (request.reasoning !== undefined) body.reasoning = request.reasoning;
  if (request.thinking !== undefined) body.thinking = request.thinking;

  return body;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function usageFromChunk(raw: unknown): Partial<Usage> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = numberOrUndefined(
    usage.prompt_tokens ?? usage.input_tokens,
  );
  const completion = numberOrUndefined(
    usage.completion_tokens ?? usage.output_tokens,
  );
  const total = numberOrUndefined(usage.total_tokens);
  const reasoning = numberOrUndefined(
    (usage.completion_tokens_details as Record<string, unknown> | undefined)
      ?.reasoning_tokens,
  );
  const cached = numberOrUndefined(
    (usage.prompt_tokens_details as Record<string, unknown> | undefined)
      ?.cached_tokens,
  );

  if (
    prompt === undefined &&
    completion === undefined &&
    total === undefined &&
    reasoning === undefined &&
    cached === undefined
  ) {
    return undefined;
  }

  const result: Partial<Usage> = {};
  if (prompt !== undefined) result.promptTokens = prompt;
  if (completion !== undefined) result.completionTokens = completion;
  if (total !== undefined) result.totalTokens = total;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  if (cached !== undefined) result.cachedTokens = cached;
  return result;
}

/** Convert one Chat Completions chunk into normalized events. */
export function eventsFromChunk(chunk: unknown): UpstreamEvent[] {
  if (!chunk || typeof chunk !== "object") return [];
  const raw = chunk as Record<string, unknown>;
  const events: UpstreamEvent[] = [];

  const error = raw.error as
    | { message?: string; code?: string; type?: string }
    | undefined;
  if (error) {
    events.push({
      type: "error",
      message: String(error.message ?? "upstream error"),
      code: String(error.code ?? error.type ?? "upstream_error"),
    });
    return events;
  }

  const usage = usageFromChunk(raw.usage);
  if (usage) events.push({ type: "usage", usage });

  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  for (const choiceRaw of choices) {
    if (!choiceRaw || typeof choiceRaw !== "object") continue;
    const choice = choiceRaw as Record<string, unknown>;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<
      string,
      unknown
    >;

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      events.push({ type: "reasoning", delta: delta.reasoning_content });
    } else if (typeof delta.reasoning === "string" && delta.reasoning) {
      events.push({ type: "reasoning", delta: delta.reasoning });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push({ type: "text", delta: delta.content });
    } else if (Array.isArray(delta.content)) {
      for (const partRaw of delta.content) {
        const part = partRaw as Record<string, unknown>;
        if (typeof part?.text === "string" && part.text) {
          events.push({ type: "text", delta: part.text });
        }
      }
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolRaw of toolCalls) {
      const tool = toolRaw as Record<string, unknown>;
      const fn = (tool.function ?? {}) as Record<string, unknown>;
      events.push({
        type: "tool",
        index:
          typeof tool.index === "number" ? tool.index : 0,
        id: typeof tool.id === "string" ? tool.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        argumentsDelta:
          typeof fn.arguments === "string" ? fn.arguments : undefined,
      });
    }

    const finishReason = choice.finish_reason;
    if (typeof finishReason === "string" && finishReason.length > 0) {
      events.push({ type: "finish", reason: finishReason });
    }
  }

  return events;
}

interface UpstreamStreamOptions {
  signal?: AbortSignal;
  identity?: UpstreamIdentity;
}

export interface UpstreamStatus {
  ok: boolean;
  status: number;
  logId?: string;
  error?: string;
}

export class UpstreamClient {
  readonly config: Config;
  readonly #fetch: typeof fetch;
  #lastStatus: UpstreamStatus = { ok: true, status: 0 };

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.#fetch = fetchImpl;
  }

  get lastStatus(): UpstreamStatus {
    return this.#lastStatus;
  }

  /** Bun fetch proxy option; omitted when UPSTREAM_PROXY is unset. */
  #proxyOption(): { proxy?: string } {
    return this.config.upstreamProxy
      ? { proxy: this.config.upstreamProxy }
      : {};
  }

  /** Fetch the public Zen model catalog (authenticated with the public key). */
  async fetchCatalog(signal?: AbortSignal): Promise<unknown> {
    const headers = buildUpstreamHeaders(this.config, {
      stream: false,
      identity: { requestId: generateRequestId() },
    });
    const response = await this.#fetch(this.config.upstreamModelsUrl, {
      method: "GET",
      headers,
      signal,
      ...this.#proxyOption(),
    });
    if (!response.ok) {
      const raw = await safeJson(response);
      this.#lastStatus = {
        ok: false,
        status: response.status,
        error: errorMessage(raw),
      };
      throw this.#errorFromResponse(response, raw);
    }
    this.#lastStatus = { ok: true, status: response.status };
    return response.json();
  }

  /**
   * Send a canonical chat request upstream, always as an SSE stream, and yield
   * normalized events. The upstream connection is aborted if the returned
   * iterator is closed early (client disconnect) or the signal fires.
   */
  async *streamChat(
    request: ChatRequest,
    options: UpstreamStreamOptions = {},
  ): AsyncGenerator<UpstreamEvent, void, unknown> {
    const url = `${this.config.upstreamBaseUrl}/chat/completions`;
    const identity = options.identity;
    const headers = buildUpstreamHeaders(this.config, {
      stream: true,
      identity,
    });
    const body = buildUpstreamBody(request, this.config);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
        ...this.#proxyOption(),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new UpstreamError({
        status: 502,
        message: `Could not reach OpenCode Zen: ${(error as Error).message}`,
        code: "upstream_unreachable",
      });
    }

    const logId = response.headers.get("x-opencode-log-id") ?? undefined;
    if (!response.ok) {
      const raw = await safeJson(response);
      this.#lastStatus = {
        ok: false,
        status: response.status,
        logId,
        error: errorMessage(raw),
      };
      throw this.#errorFromResponse(response, raw, logId);
    }

    this.#lastStatus = { ok: true, status: response.status, logId };
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream") || !response.body) {
      // Some gateways ignore `stream` and return a plain JSON completion.
      const raw = await response.json().catch(() => undefined);
      yield* eventsFromJsonCompletion(raw);
      return;
    }

    try {
      for await (const message of parseSSE(response.body)) {
        const data = message.data.trim();
        if (!data) continue;
        if (data === "[DONE]") {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        for (const event of eventsFromChunk(parsed)) {
          if (event.type === "error") throw toEventError(event.message, event.code);
          yield event;
        }
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError({
        status: 502,
        message: `Upstream stream failed: ${(error as Error).message}`,
        code: "upstream_stream_error",
      });
    }
  }

  #errorFromResponse(
    response: Response,
    raw: unknown,
    logId?: string,
  ): UpstreamError {
    const parsed = (raw ?? {}) as Record<string, unknown>;
    const nested =
      (parsed.error as Record<string, unknown> | undefined) ?? undefined;
    const message =
      (typeof nested?.message === "string" && nested.message) ||
      (typeof parsed.message === "string" && parsed.message) ||
      `OpenCode Zen returned HTTP ${response.status}`;
    const code =
      (typeof nested?.code === "string" && nested.code) ||
      (typeof nested?.type === "string" && nested.type) ||
      (typeof parsed.type === "string" && parsed.type) ||
      "upstream_error";
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : undefined;

    return new UpstreamError({
      status: response.status,
      message,
      code,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      logId,
      raw,
    });
  }
}

function toEventError(message: string, code?: string): UpstreamError {
  return new UpstreamError({
    status: 502,
    message,
    code: code ?? "upstream_error",
  });
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 2000) };
  }
}

function errorMessage(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const nested = obj.error as Record<string, unknown> | undefined;
  return (
    (typeof nested?.message === "string" && nested.message) ||
    (typeof obj.message === "string" && obj.message) ||
    undefined
  );
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Flatten a non-streaming Chat Completions JSON response into events. */
export function* eventsFromJsonCompletion(
  raw: unknown,
): Generator<UpstreamEvent> {
  if (!raw || typeof raw !== "object") {
    yield { type: "error", message: "Upstream returned an empty response." };
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.error) {
    const nested = obj.error as Record<string, unknown>;
    yield {
      type: "error",
      message: String(nested.message ?? "upstream error"),
      code: String(nested.code ?? nested.type ?? "upstream_error"),
    };
    return;
  }

  const usage = usageFromChunk(obj.usage);
  if (usage) yield { type: "usage", usage };

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const choiceRaw of choices) {
    const choice = choiceRaw as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    if (typeof message.reasoning_content === "string" && message.reasoning_content) {
      yield { type: "reasoning", delta: message.reasoning_content };
    }
    const content = message.content;
    if (typeof content === "string" && content) {
      yield { type: "text", delta: content };
    } else if (Array.isArray(content)) {
      for (const partRaw of content) {
        const part = partRaw as Record<string, unknown>;
        if (typeof part?.text === "string" && part.text) {
          yield { type: "text", delta: part.text };
        }
      }
    }
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    for (const toolRaw of toolCalls) {
      const tool = toolRaw as Record<string, unknown>;
      const fn = (tool.function ?? {}) as Record<string, unknown>;
      yield {
        type: "tool",
        index: typeof tool.index === "number" ? tool.index : 0,
        id: typeof tool.id === "string" ? tool.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        argumentsDelta:
          typeof fn.arguments === "string" ? fn.arguments : undefined,
      };
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      yield { type: "finish", reason: choice.finish_reason };
    }
  }
}
