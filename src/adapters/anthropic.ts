/**
 * Anthropic Messages adapter (`POST /v1/messages`).
 *
 * Parses Anthropic's Messages request format into the canonical `ChatRequest`
 * and renders the normalized upstream event stream back either as Anthropic
 * SSE events (`message_start` -> content blocks -> `message_delta` ->
 * `message_stop`) or as a single Message JSON object.
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
  randomToken,
  toOpenAITool,
} from "./shared.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

/** Flatten Anthropic system content (string or text-block array) to text. */
function systemToText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  let text = "";
  for (const block of asArray(value)) {
    if (isObject(block) && typeof block.text === "string") text += block.text;
  }
  return text.trim() ? text : undefined;
}

/** Anthropic image block -> OpenAI image_url content part. */
function imageToPart(block: JsonObject): JsonObject | undefined {
  const source = isObject(block.source) ? block.source : undefined;
  if (!source) return undefined;
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType =
      typeof source.media_type === "string" ? source.media_type : "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }
  return undefined;
}

/** Flatten a tool_result content value (string or text-block array). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isObject(block) && typeof block.text === "string") return block.text;
        return JSON.stringify(block);
      })
      .join("");
  }
  return JSON.stringify(content);
}

/** Collapse text-only parts to a plain string; keep an array for multimodal. */
function partsToContent(parts: JsonObject[]): ChatMessage["content"] {
  if (parts.length === 0) return "";
  const textOnly = parts.every((part) => part.type === "text");
  if (textOnly) {
    return parts.map((part) => String(part.text ?? "")).join("");
  }
  return parts;
}

/** Convert a user message's content blocks into canonical messages. */
function convertUserMessage(content: unknown): ChatMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  const parts: JsonObject[] = [];
  const toolMessages: ChatMessage[] = [];

  for (const block of asArray(content)) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
      continue;
    }
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const part = imageToPart(block);
      if (part) parts.push(part);
      continue;
    }
    if (block.type === "tool_result") {
      toolMessages.push({
        role: "tool",
        tool_call_id:
          typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        content: toolResultText(block.content),
      });
      continue;
    }
    if (block.type === "document") continue;
    if (typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    }
  }

  const messages: ChatMessage[] = [];
  if (parts.length > 0) {
    messages.push({ role: "user", content: partsToContent(parts) });
  }
  messages.push(...toolMessages);
  return messages;
}

/** Convert an assistant message (text/thinking/tool_use blocks) to canonical. */
function convertAssistantMessage(content: unknown): ChatMessage {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of asArray(content)) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      thinkingParts.push(block.thinking);
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id:
          typeof block.id === "string" && block.id
            ? block.id
            : generateMessageId("call"),
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
        },
      });
    }
  }

  const message: ChatMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (thinkingParts.length > 0) {
    message.reasoning_content = thinkingParts.join("");
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function convertTools(value: unknown): OpenAITool[] {
  const tools: OpenAITool[] = [];
  for (const rawTool of asArray(value)) {
    if (!isObject(rawTool)) continue;
    const converted = toOpenAITool({
      name: typeof rawTool.name === "string" ? rawTool.name : undefined,
      description:
        typeof rawTool.description === "string"
          ? rawTool.description
          : undefined,
      input_schema: rawTool.input_schema,
    });
    if (converted) tools.push(converted);
  }
  return tools;
}

function convertToolChoice(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  switch (value.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof value.name === "string"
        ? { type: "function", function: { name: value.name } }
        : undefined;
    default:
      return undefined;
  }
}

export function parseAnthropicMessagesRequest(
  body: unknown,
  _req: Request,
): ChatRequest {
  if (!isObject(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) throw badRequest("Missing required field: model");
  if (!Array.isArray(body.messages)) {
    throw badRequest("Missing required field: messages");
  }

  const messages: ChatMessage[] = [];
  const system = systemToText(body.system);
  if (system !== undefined) messages.push({ role: "system", content: system });

  for (const rawMessage of body.messages) {
    if (!isObject(rawMessage)) continue;
    const role = typeof rawMessage.role === "string" ? rawMessage.role : "user";
    if (role === "assistant") {
      messages.push(convertAssistantMessage(rawMessage.content));
    } else {
      messages.push(...convertUserMessage(rawMessage.content));
    }
  }

  const request: ChatRequest = {
    model,
    messages,
    stream: body.stream === true,
  };

  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") {
    request.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (typeof body.top_k === "number") request.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences.map((value) => String(value));
  } else if (typeof body.stop_sequences === "string" && body.stop_sequences) {
    request.stop = [body.stop_sequences];
  }

  const tools = convertTools(body.tools);
  if (tools.length > 0) request.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (typeof body.parallel_tool_calls === "boolean") {
    request.parallel_tool_calls = body.parallel_tool_calls;
  }

  return request;
}

/* -------------------------------------------------------------------------- */
/* Response rendering helpers                                                 */
/* -------------------------------------------------------------------------- */

type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use";

function anthropicStopReason(reason: string | null | undefined): AnthropicStopReason {
  switch (mapFinishReason(reason)) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function sseFrame(event: string, payload: unknown): string {
  return encodeSSE(JSON.stringify(payload), event);
}

interface OpenedBlock {
  frames: string[];
  index: number;
}

interface ActiveBlock {
  kind: "text" | "thinking" | "tool";
  index: number;
  toolIndex?: number;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const anthropicAdapter: Adapter = {
  format: "anthropic",

  parseRequest: parseAnthropicMessagesRequest,

  isStream(body: unknown): boolean {
    return isObject(body) && body.stream === true;
  },

  renderStream(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Response {
    const messageId = randomToken("msg_");
    const estimatedPromptTokens = estimatePromptTokens(ctx.request);

    const frames = async function* (): AsyncGenerator<string> {
      let blockCounter = 0;
      const state: { current: ActiveBlock | null } = { current: null };
      let outputText = "";
      let outputReasoning = "";
      let outputToolArguments = "";
      let finishReason: string | null = null;
      let upstreamPromptTokens: number | undefined;
      let upstreamCompletionTokens: number | undefined;

      const closeCurrentBlock = (): string | undefined => {
        const active = state.current;
        if (!active) return undefined;
        const index = active.index;
        state.current = null;
        return sseFrame("content_block_stop", {
          type: "content_block_stop",
          index,
        });
      };

      const openTextBlock = (): OpenedBlock => {
        const blockFrames: string[] = [];
        const closeFrame = closeCurrentBlock();
        if (closeFrame) blockFrames.push(closeFrame);
        const index = blockCounter++;
        state.current = { kind: "text", index };
        blockFrames.push(
          sseFrame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
        );
        return { frames: blockFrames, index };
      };

      const openThinkingBlock = (): OpenedBlock => {
        const blockFrames: string[] = [];
        const closeFrame = closeCurrentBlock();
        if (closeFrame) blockFrames.push(closeFrame);
        const index = blockCounter++;
        state.current = { kind: "thinking", index };
        blockFrames.push(
          sseFrame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
        return { frames: blockFrames, index };
      };

      const openToolBlock = (
        toolIndex: number,
        id: string | undefined,
        name: string | undefined,
      ): OpenedBlock => {
        const blockFrames: string[] = [];
        const closeFrame = closeCurrentBlock();
        if (closeFrame) blockFrames.push(closeFrame);
        const index = blockCounter++;
        state.current = { kind: "tool", index, toolIndex };
        blockFrames.push(
          sseFrame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: id && id.length > 0 ? id : randomToken("toolu_"),
              name: name ?? "",
              input: {},
            },
          }),
        );
        return { frames: blockFrames, index };
      };

      // message_start
      yield sseFrame("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: ctx.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: estimatedPromptTokens,
            output_tokens: 0,
          },
        },
      });
      yield sseFrame("ping", { type: "ping" });

      for await (const event of events) {
        switch (event.type) {
          case "text": {
            outputText += event.delta;
            if (state.current === null || state.current.kind !== "text") {
              const opened = openTextBlock();
              for (const frame of opened.frames) yield frame;
            }
            const index = state.current!.index;
            yield sseFrame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: event.delta },
            });
            break;
          }
          case "reasoning": {
            outputReasoning += event.delta;
            if (state.current === null || state.current.kind !== "thinking") {
              const opened = openThinkingBlock();
              for (const frame of opened.frames) yield frame;
            }
            const index = state.current!.index;
            yield sseFrame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: event.delta },
            });
            break;
          }
          case "tool": {
            const argumentsDelta = event.argumentsDelta ?? "";
            outputToolArguments += argumentsDelta;
            let index: number;
            if (
              state.current !== null &&
              state.current.kind === "tool" &&
              state.current.toolIndex === event.index
            ) {
              index = state.current.index;
            } else {
              const opened = openToolBlock(event.index, event.id, event.name);
              for (const frame of opened.frames) yield frame;
              index = opened.index;
            }
            if (argumentsDelta.length > 0) {
              yield sseFrame("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: argumentsDelta,
                },
              });
            }
            break;
          }
          case "usage": {
            if (event.usage.promptTokens !== undefined) {
              upstreamPromptTokens = event.usage.promptTokens;
            }
            if (event.usage.completionTokens !== undefined) {
              upstreamCompletionTokens = event.usage.completionTokens;
            }
            break;
          }
          case "finish": {
            finishReason = event.reason;
            break;
          }
          case "error": {
            const closeFrame = closeCurrentBlock();
            if (closeFrame) yield closeFrame;
            yield sseFrame("error", {
              type: "error",
              error: { type: "api_error", message: event.message },
            });
            return;
          }
          default:
            break;
        }
      }

      const closeFrame = closeCurrentBlock();
      if (closeFrame) yield closeFrame;

      const stopReason =
        finishReason === null && outputToolArguments.length > 0
          ? "tool_use"
          : anthropicStopReason(finishReason);
      const inputTokens = upstreamPromptTokens ?? estimatedPromptTokens;
      const outputTokens =
        upstreamCompletionTokens ??
        estimateTokens(outputText) +
          estimateTokens(outputReasoning) +
          estimateTokens(outputToolArguments);

      yield sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      yield sseFrame("message_stop", { type: "message_stop" });
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

    const content: JsonObject[] = [];
    if (collected.reasoning) {
      content.push({ type: "thinking", thinking: collected.reasoning });
    }
    if (collected.text) {
      content.push({ type: "text", text: collected.text });
    }
    for (const tool of collected.toolCalls) {
      content.push({
        type: "tool_use",
        id: tool.id || randomToken("toolu_"),
        name: tool.name,
        input: (() => {
          const trimmed = tool.arguments.trim();
          if (!trimmed) return {};
          try {
            const parsed: unknown = JSON.parse(trimmed);
            return isObject(parsed) ? parsed : { value: parsed };
          } catch {
            return { raw: tool.arguments };
          }
        })(),
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });

    const inputTokens =
      collected.usage.promptTokens || estimatePromptTokens(ctx.request);
    const outputTokens =
      collected.usage.completionTokens ||
      estimateTokens(collected.text) + estimateTokens(collected.reasoning);

    const stopReason =
      collected.finishReason === null && collected.toolCalls.length > 0
        ? "tool_use"
        : anthropicStopReason(collected.finishReason);

    return jsonResponse({
      id: randomToken("msg_"),
      type: "message",
      role: "assistant",
      model: ctx.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    });
  },

  renderModels(models: ModelInfo[], _req: Request): Response {
    const data = models.map((model) => ({
      type: "model",
      id: model.id,
      display_name: model.name,
      created_at: new Date(model.created * 1000).toISOString(),
    }));
    return jsonResponse({
      data,
      has_more: false,
      first_id: data.length > 0 ? data[0].id : null,
      last_id: data.length > 0 ? data[data.length - 1].id : null,
    });
  },

  renderError(status: number, message: string, _code?: string): Response {
    return jsonResponse(
      {
        type: "error",
        error: {
          type: anthropicErrorType(status),
          message,
        },
      },
      status,
    );
  },
};
