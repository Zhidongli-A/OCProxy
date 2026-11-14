/**
 * Shared canonical types.
 *
 * Every downstream API format (OpenAI Chat Completions, OpenAI Responses,
 * Anthropic Messages, Google Gemini generateContent) is parsed into the
 * canonical `ChatRequest` below. The relay always talks to OpenCode Zen using
 * the OpenAI Chat Completions wire format (Zen's official surface), and maps
 * the resulting event stream back into whatever the downstream client speaks.
 */

export type DownstreamFormat = "openai" | "anthropic" | "gemini" | "responses";

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: MessageRole | string;
  content: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * Canonical request. This is intentionally shaped like an OpenAI Chat
 * Completions body so it can be forwarded upstream with minimal translation.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[] | null;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
  reasoning_effort?: string;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
  [key: string]: unknown;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

/** Normalized event stream produced from the upstream SSE response. */
export type UpstreamEvent =
  | { type: "start"; id: string; model: string; created: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "finish"; reason: string | null }
  | { type: "error"; message: string; code?: string };

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  structuredOutput: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  created: number;
  ownedBy: string;
  description?: string;
  contextLength?: number;
  /** Catalog `limit.input`: hard input cap (may be below context). */
  inputLength?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  reasoningEfforts?: string[];
  /** Native Zen API surface, e.g. "chat-completions" or "responses". */
  api: string;
  free: true;
  raw?: unknown;
}

/** Context handed to an adapter when rendering a response. */
export interface RenderContext {
  /** Model id exactly as the downstream client requested it. */
  model: string;
  /** Upstream/target model id (free catalog id). */
  resolvedModel: string;
  requestId: string;
  created: number;
  request: ChatRequest;
}

export interface Adapter {
  readonly format: DownstreamFormat;

  /**
   * Convert a downstream request body into the canonical ChatRequest.
   * Throw `HttpError` for malformed input.
   */
  parseRequest(body: unknown, req: Request): ChatRequest;

  /** Whether the downstream client asked for a streamed response. */
  isStream(body: unknown, req: Request): boolean;

  /** Render the normalized upstream stream as a streaming HTTP response. */
  renderStream(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Response;

  /** Render the normalized upstream stream as a single JSON response. */
  renderComplete(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Promise<Response>;

  /** Render the free-model catalog in this format's model-list shape. */
  renderModels(models: ModelInfo[], req: Request): Response;

  /** Render an error in this format's error envelope. */
  renderError(status: number, message: string, code?: string): Response;
}

/**
 * Runtime configuration. Deliberately small: everything that shapes the wire
 * identity (User-Agent, x-opencode-*, project id, session ids, trace headers),
 * the free-only catalog filter, the local token estimate and the single 429
 * retry is computed by the relay itself and cannot be configured.
 */
export interface Config {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamModelsUrl: string;
  /** Optional HTTP CONNECT proxy for upstream requests (e.g. http://127.0.0.1:7890). */
  upstreamProxy?: string;
  /** Per-request upstream timeout (ms). */
  requestTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface CollectedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface Collected {
  id: string;
  model: string;
  created: number;
  text: string;
  reasoning: string;
  toolCalls: CollectedToolCall[];
  finishReason: string | null;
  usage: Usage;
}
