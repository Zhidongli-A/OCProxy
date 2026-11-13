/**
 * HTTP server and routing.
 *
 * Downstream surface:
 *   POST /v1/chat/completions            OpenAI Chat Completions
 *   POST /v1/responses                   OpenAI Responses
 *   POST /v1/messages                    Anthropic Messages
 *   POST /v1beta/models/{m}:generateContent, :streamGenerateContent  Gemini
 *   GET  /v1/models, /v1/models/{id}     model catalog (OpenAI / Anthropic shape)
 *   GET  /v1beta/models, /v1beta/models/{id}  model catalog (Gemini shape)
 *
 * All requests require no authentication: any API key (or none) is ignored.
 */

import type {
  Adapter,
  ChatRequest,
  DownstreamFormat,
  Config,
  ModelInfo,
  UpstreamEvent,
} from "./types.ts";
import { loadConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { UpstreamClient, UpstreamError } from "./upstream.ts";
import { ModelRegistry, normalizeModelId } from "./models.ts";
import {
  downstreamIdentity,
  forgetConversationSession,
  generateSessionId,
  sessionForConversation,
} from "./identity.ts";
import { applyHarness, applyToolBridge } from "./harness.ts";
import { openAIAdapter } from "./adapters/openai.ts";
import { anthropicAdapter } from "./adapters/anthropic.ts";
import { geminiAdapter } from "./adapters/gemini.ts";
import { responsesAdapter } from "./adapters/responses.ts";
import { jsonResponse } from "./adapters/shared.ts";
import { estimateTokens } from "./collect.ts";

export interface AppOptions {
  config?: Config;
  upstream?: UpstreamClient;
  models?: ModelRegistry;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ADAPTERS: Record<DownstreamFormat, Adapter> = {
  openai: openAIAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  responses: responsesAdapter,
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface AppRuntime {
  config: Config;
  upstream: UpstreamClient;
  models: ModelRegistry;
  handler: (req: Request) => Promise<Response>;
}

export function createApp(options: AppOptions = {}): AppRuntime {
  const config = options.config ?? loadConfig();
  const upstream =
    options.upstream ?? new UpstreamClient(config, options.fetchImpl ?? fetch);
  const registry =
    options.models ??
    new ModelRegistry({
      config,
      upstream,
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now,
      offline: config.dryRun,
    });
  const now = options.now ?? Date.now;

  const handler = async (req: Request): Promise<Response> => {
    const started = now();
    const url = new URL(req.url);
    let adapter: Adapter = openAIAdapter;
    let modelLabel = "";
    let activeRequest: ChatRequest | undefined;

    try {
      if (req.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      const route = matchRoute(req, url);

      if (route.kind === "root") {
        return withCors(await landingPage(registry, config));
      }
      if (route.kind === "health") {
        return withCors(
          jsonResponse({
            status: "ok",
            service: "OCProxy",
            upstream: upstream.lastStatus,
            catalog: registry.status,
          }),
        );
      }
      if (route.kind === "count-tokens") {
        const body = await readJson(req);
        return withCors(
          jsonResponse({
            input_tokens: estimateTokens(JSON.stringify(body ?? "")),
          }),
        );
      }
      if (route.kind === "models-list") {
        adapter = ADAPTERS[route.format];
        const models = await registry.getModels();
        return withCors(adapter.renderModels(models, req));
      }
      if (route.kind === "models-get") {
        adapter = ADAPTERS[route.format];
        const models = await registry.getModels();
        const model = models.find(
          (entry) => entry.id.toLowerCase() === route.id.toLowerCase(),
        );
        if (!model) {
          return withCors(
            adapter.renderError(
              404,
              `Model '${route.id}' is not a free OpenCode Zen model.`,
              "model_not_found",
            ),
          );
        }
        return withCors(adapter.renderModels([model], req));
      }

      // Chat-style route.
      adapter = ADAPTERS[route.format];
      const body = await readJson(req);
      const chatRequest = adapter.parseRequest(body, req);
      activeRequest = chatRequest;
      modelLabel = chatRequest.model;

      const resolved = await resolveModel(registry, config, chatRequest.model);
      chatRequest.model = resolved.id;

      // The free-tier gate requires a minimal <env> block plus a `read` tool.
      // applyHarness also renames gate-refused tool names and installs the
      // response-side tool bridge.
      const bridge = applyHarness(chatRequest, config);

      // Reject clearly-oversized prompts before spending the free token bucket
      // and before the provider answers with a raw 400.
      if (config.contextGuard) enforceContextBudget(chatRequest, resolved, config);

      // Reuse a genuine inbound OpenCode session id; otherwise derive one per
      // conversation. A 429 retry always uses a brand-new session.
      const sessionHint =
        downstreamIdentity(req)?.sessionId ??
        sessionForConversation(chatRequest);
      const renderCtx = {
        model: chatRequest.model,
        resolvedModel: resolved.id,
        requestId: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
        created: Math.floor(now() / 1000),
        request: chatRequest,
      };

      const signal = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(config.requestTimeoutMs),
      ]);

      const openUpstream = (identity?: { sessionId?: string }) =>
        config.dryRun
          ? dryRunEvents()
          : upstream.streamChat(chatRequest, { signal, identity });

      let events = openUpstream(
        sessionHint ? { sessionId: sessionHint } : undefined,
      );

      // Open the upstream stream and wait for the first event (or the HTTP
      // error) before committing the downstream response. Without this, an
      // upstream 4xx/5xx would be hidden behind an already-sent 200 SSE body.
      let peeked;
      try {
        peeked = await peekEvents(events);
      } catch (error) {
        // A burned session or a transient edge 429 can succeed immediately
        // with a fresh session; retry once, never in a loop.
        if (
          config.retryOn429 &&
          !config.dryRun &&
          error instanceof UpstreamError &&
          error.status === 429
        ) {
          forgetConversationSession(chatRequest);
          events = openUpstream({ sessionId: generateSessionId() });
          peeked = await peekEvents(events);
        } else {
          throw error;
        }
      }
      const bridged = applyToolBridge(peeked, bridge);

      const stream = adapter.isStream(body, req);
      const response = stream
        ? adapter.renderStream(bridged, renderCtx)
        : await adapter.renderComplete(bridged, renderCtx);
      logRequest(config, req, adapter.format, modelLabel, stream, now() - started);
      return withCors(response);
    } catch (error) {
      // A burned conversation session keeps returning 429 even on a good IP.
      // Drop its cached mapping so the next retry mints a fresh session.
      if (
        activeRequest &&
        error instanceof UpstreamError &&
        error.status === 429
      ) {
        forgetConversationSession(activeRequest);
      }
      const response = renderFailure(error, adapter);
      logRequest(
        config,
        req,
        adapter.format,
        modelLabel,
        false,
        now() - started,
        response.status,
        error instanceof Error ? error.message : String(error),
      );
      return withCors(response);
    }
  };

  return { config, upstream, models: registry, handler };
}

/** Synthetic stream used when UPSTREAM_DRY_RUN is on: no network at all. */
async function* dryRunEvents(): AsyncGenerator<UpstreamEvent> {
  yield {
    type: "start",
    id: "dry-run",
    model: "dry-run",
    created: Math.floor(Date.now() / 1000),
  };
  yield {
    type: "text",
    delta: "[dry-run] upstream request suppressed (UPSTREAM_DRY_RUN=1).",
  };
  yield { type: "finish", reason: "stop" };
}

/**
 * Eagerly advance the upstream iterator by one event so connection-level and
 * HTTP errors surface before the downstream response headers are flushed.
 */
async function peekEvents(
  events: AsyncIterable<UpstreamEvent>,
): Promise<AsyncIterable<UpstreamEvent>> {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();

  return (async function* (): AsyncGenerator<UpstreamEvent> {
    if (first.done) return;
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
}

/** Rough prompt token estimate (~4 chars/token) including preamble and tools. */
function estimateRequestTokens(request: import("./types.ts").ChatRequest): number {
  let chars = 0;
  for (const message of request.messages ?? []) {
    chars += JSON.stringify(message).length;
  }
  chars += JSON.stringify(request.tools ?? []).length;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Provider context limits are authoritative: the catalog's `limit.context`
 * (total window) and `limit.input` (hard input cap). Reject before calling
 * upstream so oversized requests fail fast with a clear 400 instead of
 * burning quota or surfacing a raw provider error.
 */
function enforceContextBudget(
  request: import("./types.ts").ChatRequest,
  model: ModelInfo,
  config: Config,
): void {
  const promptTokens = estimateRequestTokens(request);
  const outputTokens =
    request.max_completion_tokens ??
    request.max_tokens ??
    config.defaultMaxCompletionTokens;

  const inputLimit = model.inputLength ?? model.contextLength;
  if (inputLimit && promptTokens > inputLimit) {
    throw new HttpError(
      400,
      `Input exceeds the context window: estimated ${promptTokens} input tokens, ` +
        `limit ${inputLimit} (${model.id}). Reduce the prompt or use a model with a larger window.`,
      "context_length_exceeded",
    );
  }

  if (model.contextLength && promptTokens + outputTokens > model.contextLength) {
    throw new HttpError(
      400,
      `Prompt plus max output exceeds the context window: estimated ` +
        `${promptTokens} input + ${outputTokens} output > ${model.contextLength} ` +
        `(${model.id}). Reduce the prompt or max tokens.`,
      "context_length_exceeded",
    );
  }
}

async function resolveModel(
  registry: ModelRegistry,
  config: Config,
  requested: string,
): Promise<ModelInfo> {
  if (config.dryRun) {
    return {
      id: normalizeModelId(requested),
      name: normalizeModelId(requested),
      created: Math.floor(Date.now() / 1000),
      ownedBy: "opencode",
      capabilities: {
        tools: true,
        reasoning: true,
        vision: false,
        structuredOutput: false,
      },
      api: "chat-completions",
      free: true,
    };
  }
  if (!config.freeModelsOnly) {
    const existing = await registry.getModel(requested).catch(() => undefined);
    if (existing) return existing;
    return {
      id: normalizeModelId(requested),
      name: normalizeModelId(requested),
      created: Math.floor(Date.now() / 1000),
      ownedBy: "opencode",
      capabilities: {
        tools: true,
        reasoning: true,
        vision: false,
        structuredOutput: false,
      },
      api: "chat-completions",
      free: true,
    };
  }
  return registry.resolve(requested);
}

type Route =
  | { kind: "root" }
  | { kind: "health" }
  | { kind: "count-tokens" }
  | { kind: "models-list"; format: DownstreamFormat }
  | { kind: "models-get"; format: DownstreamFormat; id: string }
  | { kind: "chat"; format: DownstreamFormat };

export function matchRoute(req: Request, url: URL): Route {
  const pathname = normalizePath(url.pathname);
  const method = req.method.toUpperCase();

  if (pathname === "/" || pathname === "") return { kind: "root" };
  if (pathname === "/health" || pathname === "/healthz") {
    return { kind: "health" };
  }

  const gemini = pathname.match(
    /^\/(?:v1beta|v1|v1alpha)?\/?models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/,
  );
  if (gemini && method === "POST") {
    if (gemini[2] === "countTokens") return { kind: "count-tokens" };
    return { kind: "chat", format: "gemini" };
  }

  if (method === "POST") {
    if (
      pathname === "/v1/chat/completions" ||
      pathname === "/chat/completions" ||
      pathname === "/v1/completions" ||
      pathname === "/completions"
    ) {
      return { kind: "chat", format: "openai" };
    }
    if (pathname === "/v1/responses" || pathname === "/responses") {
      return { kind: "chat", format: "responses" };
    }
    if (
      pathname === "/v1/messages" ||
      pathname === "/messages" ||
      pathname === "/v1/messages/count_tokens" ||
      pathname === "/messages/count_tokens"
    ) {
      if (pathname.endsWith("/count_tokens")) return { kind: "count-tokens" };
      return { kind: "chat", format: "anthropic" };
    }
  }

  const isBeta = /^\/v1beta\//.test(pathname);
  const format: DownstreamFormat = isBeta
    ? "gemini"
    : req.headers.get("anthropic-version")
      ? "anthropic"
      : "openai";

  if (method === "GET") {
    const listMatch = pathname.match(
      /^\/(?:v1beta\/|v1\/)?models\/?$/,
    );
    if (listMatch) return { kind: "models-list", format };

    const getMatch = pathname.match(
      /^\/(?:v1beta\/|v1\/)?models\/([^/]+)$/,
    );
    if (getMatch) return { kind: "models-get", format, id: getMatch[1] };
  }

  throw new HttpError(404, `Unknown route: ${req.method} ${url.pathname}`, "not_found");
}

function normalizePath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) {
    throw new HttpError(400, "Request body must be JSON.", "invalid_request_error");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.", "invalid_request_error");
  }
}

function renderFailure(error: unknown, adapter: Adapter): Response {
  if (error instanceof HttpError) {
    return adapter.renderError(error.status, error.message, error.code);
  }
  if (error instanceof UpstreamError) {
    const response = adapter.renderError(error.status, error.message, error.code);
    if (error.retryAfterSeconds !== undefined) {
      const headers = new Headers(response.headers);
      headers.set("Retry-After", String(error.retryAfterSeconds));
      if (error.logId) headers.set("X-Upstream-Log-Id", error.logId);
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }
    return response;
  }
  const message =
    error instanceof Error ? error.message : "Unexpected relay error.";
  return adapter.renderError(502, message, "relay_error");
}

function logRequest(
  config: Config,
  req: Request,
  format: DownstreamFormat,
  model: string,
  stream: boolean,
  durationMs: number,
  status = 200,
  error?: string,
): void {
  if (config.logLevel === "error" && status < 500) return;
  if (config.logLevel === "warn" && status < 400) return;
  const suffix = error ? ` error=${JSON.stringify(error.slice(0, 240))}` : "";
  console.log(
    `[OCProxy] ${req.method} ${new URL(req.url).pathname} ` +
      `format=${format} model=${model || "-"} stream=${stream} ` +
      `status=${status} ${durationMs}ms${suffix}`,
  );
}

async function landingPage(
  registry: ModelRegistry,
  config: Config,
): Promise<Response> {
  const models = await registry.getModels().catch((): ModelInfo[] => []);
  const status = registry.status;
  const rows = models
    .map(
      (model) =>
        `<tr><td><code>${escapeHtml(model.id)}</code></td>` +
        `<td>${escapeHtml(model.name)}</td>` +
        `<td>${model.contextLength ? Math.round(model.contextLength / 1000) + "k" : "?"}</td>` +
        `<td>${model.capabilities.tools ? "tools" : ""} ` +
        `${model.capabilities.reasoning ? "reasoning" : ""}</td></tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OCProxy</title>
<style>
  :root{color-scheme:dark}
  body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
       margin:0;padding:48px 24px;background:#0d1117;color:#e6edf3}
  main{max-width:860px;margin:0 auto}
  h1{font-size:28px;margin:0 0 6px} h2{margin-top:32px;font-size:19px}
  p.lead{color:#9da7b3;margin-top:0}
  code{background:#161b22;border:1px solid #30363d;border-radius:5px;padding:1px 5px}
  pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;overflow:auto}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #21262d}
  th{color:#9da7b3;font-weight:500}
  .pill{display:inline-block;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;
        border-radius:999px;padding:1px 9px;font-size:12px;margin-left:8px;vertical-align:middle}
  a{color:#58a6ff}
  .muted{color:#7d8590;font-size:13px}
</style>
</head>
<body><main>
  <h1>OCProxy<span class="pill">free models only</span></h1>
  <p class="lead">OpenAI-compatible, Anthropic-compatible and Gemini-compatible endpoint in front of
  OpenCode Zen's anonymous free tier. Client API keys are ignored.</p>
  <p class="muted">Catalog source: ${status.source} 路 ${status.models} free models 路 base URL
  <code>${escapeHtml(config.upstreamBaseUrl)}</code></p>
  <h2>Endpoints</h2>
  <pre>POST /v1/chat/completions              OpenAI Chat Completions
POST /v1/responses                     OpenAI Responses
POST /v1/messages                      Anthropic Messages
POST /v1beta/models/{model}:generateContent
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
GET  /v1/models                        OpenAI model list (free only)
GET  /v1beta/models?key=anything       Gemini model list (key ignored)
GET  /health</pre>
  <h2>Free models</h2>
  <table><thead><tr><th>Model id</th><th>Name</th><th>Context</th><th>Capabilities</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <h2>Quick test</h2>
  <pre>curl -N http://127.0.0.1:${config.port}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"${escapeHtml(models[0]?.id ?? "model-id")}","messages":[{"role":"user","content":"hello"}]}'</pre>
</main></body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

