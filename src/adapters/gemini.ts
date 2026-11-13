/**
 * Google Gemini adapter (`POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent`).
 *
 * Parses Gemini's `GenerateContentRequest` into the canonical `ChatRequest`
 * and renders the normalized upstream event stream back as Gemini
 * `GenerateContentResponse` chunks. Streaming follows Gemini's two supported
 * wire shapes: SSE (`?alt=sse`, `data: {...}` frames) or a JSON array stream
 * (no `alt` query parameter).
 */

import type {
  Adapter,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  OpenAITool,
  RenderContext,
  ToolCall,
  UpstreamEvent,
} from "../types.ts";
import { badRequest } from "../errors.ts";
import {
  collectEvents,
  estimatePromptTokens,
  estimateTokens,
} from "../collect.ts";
import { encodeSSE, sseResponse } from "../sse.ts";
import { generateMessageId } from "../identity.ts";
import {
  jsonResponse,
  mapFinishReason,
  toOpenAITool,
} from "./shared.ts";

type JsonObject = Record<string, unknown>;

/** Non-enumerable flag stored on the canonical request by `parseRequest`. */
const GEMINI_SSE_FLAG = "__geminiSse";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* URL / routing helpers                                                      */
/* -------------------------------------------------------------------------- */

const MODEL_PATH_PATTERN =
  /\/models\/([^/:]+):(?:generateContent|streamGenerateContent|countTokens)\/?$/;

function requestUrl(req: Request): URL | undefined {
  try {
    return new URL(req.url);
  } catch {
    return undefined;
  }
}

/** Extract the model id from the Gemini REST path. */
export function modelFromGeminiUrl(req: Request): string | undefined {
  const url = requestUrl(req);
  if (!url) return undefined;
  const match = url.pathname.match(MODEL_PATH_PATTERN);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function trimModelPrefix(value: string): string {
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function modelFromBody(body: JsonObject): string | undefined {
  const candidate = firstString(body.model, body.name);
  return candidate ? trimModelPrefix(candidate) : undefined;
}

function isGeminiStreamPath(req: Request): boolean {
  const url = requestUrl(req);
  return Boolean(url && url.pathname.includes(":streamGenerateContent"));
}

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

function systemToText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (!isObject(value)) return undefined;
  const text = asArray(value.parts)
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text.trim() ? text : undefined;
}

function convertUserContent(parts: unknown[]): ChatMessage[] {
  const contentParts: JsonObject[] = [];
  const toolMessages: ChatMessage[] = [];
  let text = "";

  for (const rawPart of parts) {
    if (!isObject(rawPart)) continue;

    if (typeof rawPart.text === "string") {
      text += rawPart.text;
      continue;
    }

    const inlineData = isObject(rawPart.inlineData)
      ? rawPart.inlineData
      : isObject(rawPart.inline_data)
        ? rawPart.inline_data
        : undefined;
    if (inlineData && typeof inlineData.data === "string") {
      const mimeType =
        firstString(inlineData.mimeType, inlineData.mime_type) ?? "image/png";
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${inlineData.data}` },
      });
      continue;
    }

    const functionResponse = isObject(rawPart.functionResponse)
      ? rawPart.functionResponse
      : isObject(rawPart.function_response)
        ? rawPart.function_response
        : undefined;
    if (functionResponse) {
      const name = firstString(functionResponse.name) ?? "";
      toolMessages.push({
        role: "tool",
        tool_call_id: name,
        content: JSON.stringify(functionResponse.response ?? {}),
      });
      continue;
    }

    const functionCall = isObject(rawPart.functionCall)
      ? rawPart.functionCall
      : isObject(rawPart.function_call)
        ? rawPart.function_call
        : undefined;
    if (functionCall) {
      // A function call inside a user turn is unusual; preserve it as text.
      const name = firstString(functionCall.name) ?? "";
      text += name ? `[functionCall: ${name}]` : "";
    }
  }

  const messages: ChatMessage[] = [];
  if (text.length > 0 || contentParts.length > 0) {
    if (contentParts.length === 0) {
      messages.push({ role: "user", content: text });
    } else {
      const content: JsonObject[] = [];
      if (text.length > 0) content.push({ type: "text", text });
      content.push(...contentParts);
      messages.push({ role: "user", content });
    }
  }
  messages.push(...toolMessages);
  return messages;
}

function convertModelContent(parts: unknown[]): ChatMessage {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  for (const rawPart of parts) {
    if (!isObject(rawPart)) continue;
    if (typeof rawPart.text === "string") {
      if (rawPart.thought === true) {
        reasoning += rawPart.text;
      } else {
        text += rawPart.text;
      }
      continue;
    }
    const functionCall = isObject(rawPart.functionCall)
      ? rawPart.functionCall
      : isObject(rawPart.function_call)
        ? rawPart.function_call
        : undefined;
    if (functionCall) {
      toolCalls.push({
        id: firstString(functionCall.id) ?? generateMessageId("call"),
        type: "function",
        function: {
          name: firstString(functionCall.name) ?? "",
          arguments: JSON.stringify(
            isObject(functionCall.args) ? functionCall.args : {},
          ),
        },
      });
    }
  }

  const message: ChatMessage = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function convertTools(value: unknown): OpenAITool[] {
  const declarations: JsonObject[] = [];
  for (const rawTool of asArray(value)) {
    if (!isObject(rawTool)) continue;
    const group = rawTool.functionDeclarations ?? rawTool.function_declarations;
    for (const declaration of asArray(group)) {
      if (isObject(declaration)) declarations.push(declaration);
    }
  }

  const tools: OpenAITool[] = [];
  for (const declaration of declarations) {
    const converted = toOpenAITool({
      name: firstString(declaration.name),
      description: firstString(declaration.description),
      parameters:
        declaration.parameters ?? declaration.parametersJsonSchema,
    });
    if (converted) tools.push(converted);
  }
  return tools;
}

function convertToolChoice(
  toolConfig: JsonObject | undefined,
): { choice?: unknown; parallel?: boolean } {
  if (!toolConfig) return {};
  const callingConfig = isObject(toolConfig.functionCallingConfig)
    ? toolConfig.functionCallingConfig
    : isObject(toolConfig.function_calling_config)
      ? toolConfig.function_calling_config
      : undefined;
  if (!callingConfig) return {};

  const allowed = asArray(
    callingConfig.allowedFunctionNames ?? callingConfig.allowed_function_names,
  ).filter((name): name is string => typeof name === "string" && name.length > 0);

  if (allowed.length === 1) {
    return { choice: { type: "function", function: { name: allowed[0] } } };
  }

  switch (callingConfig.mode) {
    case "AUTO":
      return { choice: "auto" };
    case "ANY":
      return { choice: "required" };
    case "NONE":
      return { choice: "none" };
    default:
      return {};
  }
}

export function parseGeminiGenerateContentRequest(
  body: unknown,
  req: Request,
): ChatRequest {
  if (!isObject(body)) {
    throw badRequest("Request body must be a JSON object.");
  }

  const url = requestUrl(req);
  const model = modelFromGeminiUrl(req) ?? modelFromBody(body);
  if (!model) throw badRequest("Missing required field: model");
  if (!Array.isArray(body.contents)) {
    throw badRequest("Missing required field: contents");
  }

  const messages: ChatMessage[] = [];
  const systemInstruction = body.systemInstruction ?? body.system_instruction;
  const system = systemToText(systemInstruction);
  if (system !== undefined) messages.push({ role: "system", content: system });

  for (const rawContent of body.contents) {
    if (!isObject(rawContent)) continue;
    const parts = asArray(rawContent.parts);
    if (rawContent.role === "model") {
      messages.push(convertModelContent(parts));
    } else {
      messages.push(...convertUserContent(parts));
    }
  }

  const request: ChatRequest = {
    model,
    messages,
    stream: isGeminiStreamPath(req),
  };

  const generationConfig = isObject(body.generationConfig)
    ? body.generationConfig
    : isObject(body.generation_config)
      ? body.generation_config
      : undefined;
  if (generationConfig) {
    const temperature = numberValue(generationConfig.temperature);
    if (temperature !== undefined) request.temperature = temperature;
    const topP = numberValue(generationConfig.topP ?? generationConfig.top_p);
    if (topP !== undefined) request.top_p = topP;
    const topK = numberValue(generationConfig.topK ?? generationConfig.top_k);
    if (topK !== undefined) request.top_k = topK;
    const maxOutputTokens = numberValue(
      generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens,
    );
    if (maxOutputTokens !== undefined) request.max_tokens = maxOutputTokens;
    const stopSequences =
      generationConfig.stopSequences ?? generationConfig.stop_sequences;
    if (Array.isArray(stopSequences) && stopSequences.length > 0) {
      request.stop = stopSequences.map((value) => String(value));
    }
    const responseMimeType =
      generationConfig.responseMimeType ?? generationConfig.response_mime_type;
    if (responseMimeType === "application/json") {
      request.response_format = { type: "json_object" };
    }
  }

  const tools = convertTools(body.tools);
  if (tools.length > 0) request.tools = tools;

  const toolConfig = isObject(body.toolConfig)
    ? body.toolConfig
    : isObject(body.tool_config)
      ? body.tool_config
      : undefined;
  const { choice } = convertToolChoice(toolConfig);
  if (choice !== undefined) request.tool_choice = choice;

  // Remember which streaming wire shape the client asked for. The Adapter
  // interface does not hand `req` to renderStream, so carry it on the
  // canonical request (non-enumerable so it never reaches the upstream body).
  if (url) {
    const alt = url.searchParams.get("alt");
    Object.defineProperty(request, GEMINI_SSE_FLAG, {
      value: alt === null ? false : alt === "sse",
      enumerable: false,
      configurable: true,
    });
  }

  return request;
}

/* -------------------------------------------------------------------------- */
/* Response rendering helpers                                                 */
/* -------------------------------------------------------------------------- */

function geminiFinishReason(reason: string | null | undefined): string {
  switch (mapFinishReason(reason)) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
}

function parseArgumentsObject(raw: string): JsonObject {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isObject(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function geminiChunk(
  parts: JsonObject[],
  finishReason?: string,
  usageMetadata?: JsonObject,
): JsonObject {
  const candidate: JsonObject = {
    content: { role: "model", parts },
    index: 0,
  };
  if (finishReason) candidate.finishReason = finishReason;
  const chunk: JsonObject = { candidates: [candidate] };
  if (usageMetadata) chunk.usageMetadata = usageMetadata;
  return chunk;
}

function geminiUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): JsonObject {
  return {
    promptTokenCount: promptTokens,
    candidatesTokenCount: completionTokens,
    totalTokenCount: totalTokens,
  };
}

function jsonArrayStreamResponse(
  chunks: AsyncIterable<JsonObject>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode("[\n"));
        let first = true;
        for await (const chunk of chunks) {
          const json = JSON.stringify(chunk);
          controller.enqueue(encoder.encode(first ? json : `,\n${json}`));
          first = false;
        }
        controller.enqueue(encoder.encode("\n]\n"));
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
    cancel() {
      // The `for await` loop above stops when the consumer cancels.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const geminiAdapter: Adapter = {
  format: "gemini",

  parseRequest: parseGeminiGenerateContentRequest,

  isStream(_body: unknown, req: Request): boolean {
    return isGeminiStreamPath(req);
  },

  renderStream(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Response {
    const sse = ctx.request[GEMINI_SSE_FLAG] !== false;

    const chunks = async function* (): AsyncGenerator<JsonObject> {
      let outputText = "";
      let outputReasoning = "";
      let finishReason: string | null = null;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let totalTokens: number | undefined;
      const toolCalls = new Map<number, { name: string; arguments: string }>();

      for await (const event of events) {
        switch (event.type) {
          case "text": {
            outputText += event.delta;
            yield geminiChunk([{ text: event.delta }]);
            break;
          }
          case "reasoning": {
            outputReasoning += event.delta;
            yield geminiChunk([{ text: event.delta, thought: true }]);
            break;
          }
          case "tool": {
            const existing = toolCalls.get(event.index) ?? {
              name: "",
              arguments: "",
            };
            if (event.name) existing.name += event.name;
            if (event.argumentsDelta) {
              existing.arguments += event.argumentsDelta;
            }
            toolCalls.set(event.index, existing);
            break;
          }
          case "usage": {
            if (event.usage.promptTokens !== undefined) {
              promptTokens = event.usage.promptTokens;
            }
            if (event.usage.completionTokens !== undefined) {
              completionTokens = event.usage.completionTokens;
            }
            if (event.usage.totalTokens !== undefined) {
              totalTokens = event.usage.totalTokens;
            }
            break;
          }
          case "finish": {
            finishReason = event.reason;
            break;
          }
          case "error": {
            yield {
              error: {
                code: 500,
                message: event.message,
                status: "INTERNAL",
              },
            };
            return;
          }
          default:
            break;
        }
      }

      const functionCallParts: JsonObject[] = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, tool]) => ({
          functionCall: {
            name: tool.name,
            args: parseArgumentsObject(tool.arguments),
          },
        }));
      if (functionCallParts.length > 0) {
        yield geminiChunk(functionCallParts);
      }

      const inputTokens = promptTokens ?? estimatePromptTokens(ctx.request);
      const outputEstimate =
        estimateTokens(outputText) + estimateTokens(outputReasoning);
      const outputTokens = completionTokens ?? outputEstimate;
      const total = totalTokens ?? inputTokens + outputTokens;

      yield geminiChunk(
        [],
        geminiFinishReason(finishReason),
        geminiUsage(inputTokens, outputTokens, total),
      );
    };

    if (!sse) return jsonArrayStreamResponse(chunks());

    const frames = async function* (): AsyncGenerator<string> {
      for await (const chunk of chunks()) {
        yield encodeSSE(JSON.stringify(chunk));
      }
    };
    return sseResponse(frames());
  },

  async renderComplete(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Promise<Response> {
    const collected = await collectEvents(events, {
      model: ctx.model,
      id: ctx.requestId,
      created: ctx.created,
    });

    const parts: JsonObject[] = [];
    if (collected.reasoning) {
      parts.push({ text: collected.reasoning, thought: true });
    }
    if (collected.text) {
      parts.push({ text: collected.text });
    }
    for (const tool of collected.toolCalls) {
      parts.push({
        functionCall: {
          name: tool.name,
          args: parseArgumentsObject(tool.arguments),
        },
      });
    }

    const inputTokens =
      collected.usage.promptTokens || estimatePromptTokens(ctx.request);
    const outputEstimate =
      estimateTokens(collected.text) + estimateTokens(collected.reasoning);
    const outputTokens = collected.usage.completionTokens || outputEstimate;
    const totalTokens = collected.usage.totalTokens || inputTokens + outputTokens;

    return jsonResponse({
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: geminiFinishReason(collected.finishReason),
          index: 0,
        },
      ],
      usageMetadata: geminiUsage(inputTokens, outputTokens, totalTokens),
      modelVersion: ctx.model,
    });
  },

  renderModels(models: ModelInfo[], _req: Request): Response {
    return jsonResponse({
      models: models.map((model) => ({
        name: `models/${model.id}`,
        displayName: model.name,
        description: model.description ?? "",
        inputTokenLimit: model.contextLength ?? 0,
        outputTokenLimit: model.maxOutputTokens ?? 0,
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
        ],
      })),
    });
  },

  renderError(status: number, message: string, _code?: string): Response {
    const errorStatus =
      status === 401 || status === 403
        ? "PERMISSION_DENIED"
        : status === 404
          ? "NOT_FOUND"
          : status === 429
            ? "RESOURCE_EXHAUSTED"
            : status >= 500
              ? "INTERNAL"
              : "INVALID_ARGUMENT";
    return jsonResponse(
      {
        error: {
          code: status,
          message,
          status: errorStatus,
        },
      },
      status,
    );
  },
};
