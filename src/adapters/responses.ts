/**
 * OpenAI Responses adapter (`POST /v1/responses`).
 *
 * Downstream clients (Codex-style agents) speak the OpenAI Responses API: the
 * request carries `input` items plus `instructions`/`tools`/`text.format`, and
 * the response is a `response` object or a stream of
 * `response.<type>` SSE events. Upstream is always the canonical OpenAI Chat
 * Completions shape, so this adapter converts in both directions.
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
  Usage,
} from "../types.ts";
import { badRequest } from "../errors.ts";
import {
  collectEvents,
  estimatePromptTokens,
  estimateTokens,
} from "../collect.ts";
import { encodeSSE, sseResponse } from "../sse.ts";
import {
  jsonResponse,
  parseStreamFlag,
  randomToken,
  toOpenAITool,
} from "./shared.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize a Responses content value (string or content-part array) into a
 * canonical chat content value. Text parts are flattened; non-text parts are
 * preserved verbatim so multimodal content survives the relay.
 */
function responsesContentToChatContent(
  content: unknown,
): ChatMessage["content"] {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw badRequest("Input item content must be a string or an array.");
  }

  const parts: JsonObject[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!isObject(part)) continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "input_text" || type === "output_text" || type === "text") {
      parts.push({
        type: "text",
        text: typeof part.text === "string" ? part.text : "",
      });
      continue;
    }
    parts.push(part);
  }

  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => String(part.text ?? "")).join("");
  }
  return parts;
}

function messageItemToChatMessage(item: JsonObject): ChatMessage {
  const role =
    typeof item.role === "string" && item.role.length > 0 ? item.role : "user";
  const message: ChatMessage = {
    role,
    content: responsesContentToChatContent(item.content),
  };
  if (typeof item.name === "string" && item.name) message.name = item.name;
  return message;
}

function toolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

/** Append a function call to the trailing assistant turn (creating it if needed). */
function appendToolCall(messages: ChatMessage[], call: ToolCall): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    last.tool_calls = [...(last.tool_calls ?? []), call];
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [call] });
}

function appendFunctionCallItem(messages: ChatMessage[], item: JsonObject): void {
  const name = typeof item.name === "string" ? item.name : "";
  if (!name) return;
  const callId =
    typeof item.call_id === "string" && item.call_id
      ? item.call_id
      : randomToken("call_", 24);
  appendToolCall(messages, {
    id: callId,
    type: "function",
    function: {
      name,
      arguments: toolArguments(item.arguments),
    },
  });
}

function appendFunctionCallOutput(messages: ChatMessage[], item: JsonObject): void {
  const callId = typeof item.call_id === "string" ? item.call_id : "";
  const output =
    typeof item.output === "string"
      ? item.output
      : JSON.stringify(item.output ?? "");
  messages.push({ role: "tool", tool_call_id: callId, content: output });
}

function appendInput(messages: ChatMessage[], input: unknown): void {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }
  if (!Array.isArray(input)) {
    throw badRequest("Field 'input' must be a string or an array of items.");
  }

  for (const rawItem of input) {
    if (typeof rawItem === "string") {
      messages.push({ role: "user", content: rawItem });
      continue;
    }
    if (!isObject(rawItem)) continue;

    const type = typeof rawItem.type === "string" ? rawItem.type : undefined;
    // Be lenient with clients that omit `type` on plain message items.
    if (type === "message" || (type === undefined && "role" in rawItem)) {
      messages.push(messageItemToChatMessage(rawItem));
      continue;
    }
    switch (type) {
      case "function_call":
        appendFunctionCallItem(messages, rawItem);
        break;
      case "function_call_output":
        appendFunctionCallOutput(messages, rawItem);
        break;
      default:
        // reasoning / item_reference / built-in tool items are not replayable
        // against a Chat Completions upstream: ignore them.
        break;
    }
  }
}

function appendLegacyMessages(messages: ChatMessage[], value: unknown[]): void {
  for (const rawMessage of value) {
    if (!isObject(rawMessage)) continue;
    const role =
      typeof rawMessage.role === "string" && rawMessage.role
        ? rawMessage.role
        : "user";
    const content = rawMessage.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string" &&
      !Array.isArray(content)
    ) {
      throw badRequest(
        "Each message content must be a string, array, or null.",
      );
    }
    messages.push({
      ...rawMessage,
      role,
      content: (content ?? null) as ChatMessage["content"],
    } as ChatMessage);
  }
}

function parseTools(value: unknown): OpenAITool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: OpenAITool[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    // Only function tools can be forwarded to a Chat Completions upstream.
    if (entry.type !== "function") continue;
    const tool = toOpenAITool({
      name: typeof entry.name === "string" ? entry.name : undefined,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      parameters: entry.parameters,
      strict: typeof entry.strict === "boolean" ? entry.strict : undefined,
    });
    if (tool) tools.push(tool);
  }
  return tools.length > 0 ? tools : undefined;
}

function parseReasoningEffort(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return typeof value.effort === "string" && value.effort
    ? value.effort
    : undefined;
}

function parseTextFormat(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  const format = value.format;
  if (!isObject(format)) return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    const name =
      typeof format.name === "string" && format.name ? format.name : "response";
    const schema = isObject(format.schema)
      ? format.schema
      : { type: "object", properties: {} };
    return {
      type: "json_schema",
      json_schema: {
        name,
        schema,
        ...(typeof format.strict === "boolean"
          ? { strict: format.strict }
          : {}),
      },
    };
  }
  return undefined;
}

export function parseResponsesRequest(
  body: unknown,
  _req: Request,
): ChatRequest {
  if (!isObject(body)) {
    throw badRequest("Request body must be a JSON object.");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) throw badRequest("Missing required field: model");

  const messages: ChatMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (body.input !== undefined && body.input !== null) {
    appendInput(messages, body.input);
  } else if (Array.isArray(body.messages)) {
    appendLegacyMessages(messages, body.messages);
  } else {
    throw badRequest("Missing required field: input");
  }

  const request: ChatRequest = {
    model,
    messages,
    stream: parseStreamFlag(body.stream),
  };

  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") {
    request.max_tokens = body.max_output_tokens;
  }

  const tools = parseTools(body.tools);
  if (tools) request.tools = tools;
  if (body.tool_choice !== undefined) request.tool_choice = body.tool_choice;
  if (typeof body.parallel_tool_calls === "boolean") {
    request.parallel_tool_calls = body.parallel_tool_calls;
  }

  const reasoningEffort = parseReasoningEffort(body.reasoning);
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;

  const responseFormat = parseTextFormat(body.text);
  if (responseFormat !== undefined) request.response_format = responseFormat;

  return request;
}

function resolveResponseId(ctx: RenderContext): string {
  const requested = typeof ctx.requestId === "string" ? ctx.requestId : "";
  return requested.startsWith("resp_") ? requested : randomToken("resp_", 24);
}

interface ReasoningState {
  id: string;
  index: number;
  text: string;
  open: boolean;
  item: JsonObject;
}

interface MessageState {
  id: string;
  index: number;
  text: string;
  open: boolean;
  item: JsonObject;
}

interface ToolState {
  id: string;
  index: number;
  callId: string;
  name: string;
  arguments: string;
  open: boolean;
  item: JsonObject;
}

function responseUsage(
  usage: Partial<Usage> | null,
  request: ChatRequest,
  text: string,
  reasoning: string,
): JsonObject {
  const inputTokens = usage?.promptTokens || estimatePromptTokens(request);
  const outputTokens =
    usage?.completionTokens ?? estimateTokens(text) + estimateTokens(reasoning);
  const totalTokens = Math.max(
    usage?.totalTokens ?? 0,
    inputTokens + outputTokens,
  );
  const reasoningTokens =
    usage?.reasoningTokens ?? (reasoning ? estimateTokens(reasoning) : 0);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage?.cachedTokens ?? 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: totalTokens,
  };
}

export const responsesAdapter: Adapter = {
  format: "responses",

  parseRequest: parseResponsesRequest,

  isStream(body: unknown): boolean {
    return Boolean(
      body &&
        typeof body === "object" &&
        parseStreamFlag((body as Record<string, unknown>).stream),
    );
  },

  renderStream(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Response {
    const responseId = resolveResponseId(ctx);
    const created = ctx.created;
    const model = ctx.model;

    const frames = async function* (): AsyncGenerator<string> {
      let sequence = 0;
      const frame = (type: string, payload: JsonObject = {}): string =>
        encodeSSE(
          JSON.stringify({ type, sequence_number: sequence++, ...payload }),
          type,
        );

      const responseSnapshot = (
        status: string,
        output: JsonObject[],
      ): JsonObject => ({
        id: responseId,
        object: "response",
        created_at: created,
        status,
        model,
        output,
      });

      yield frame("response.created", {
        response: responseSnapshot("in_progress", []),
      });
      yield frame("response.in_progress", {
        response: responseSnapshot("in_progress", []),
      });

      let nextIndex = 0;
      const outputs: Array<{ index: number; item: JsonObject }> = [];
      const pushOutput = (state: {
        index: number;
        item: JsonObject;
      }): void => {
        outputs.push({ index: state.index, item: state.item });
      };

      let reasoning: ReasoningState | null = null;
      let message: MessageState | null = null;
      const toolItems = new Map<number, ToolState>();

      let usage: Partial<Usage> | null = null;
      let errorMessage: string | null = null;
      let errorCode: string | undefined;

      const closeReasoning = function* (): Generator<string> {
        if (!reasoning || !reasoning.open) return;
        const item = reasoning;
        item.open = false;
        item.item.summary = [{ type: "summary_text", text: item.text }];
        yield frame("response.reasoning_summary_text.done", {
          item_id: item.id,
          output_index: item.index,
          summary_index: 0,
          text: item.text,
        });
        yield frame("response.output_item.done", {
          output_index: item.index,
          item: item.item,
        });
        pushOutput(item);
      };

      const closeMessage = function* (): Generator<string> {
        if (!message || !message.open) return;
        const item = message;
        item.open = false;
        item.item.status = "completed";
        item.item.content = [
          { type: "output_text", text: item.text, annotations: [] },
        ];
        yield frame("response.output_text.done", {
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          text: item.text,
        });
        yield frame("response.content_part.done", {
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          part: { type: "output_text", text: item.text, annotations: [] },
        });
        yield frame("response.output_item.done", {
          output_index: item.index,
          item: item.item,
        });
        pushOutput(item);
      };

      const closeTool = function* (tool: ToolState): Generator<string> {
        if (!tool.open) return;
        tool.open = false;
        tool.item.name = tool.name;
        tool.item.arguments = tool.arguments;
        tool.item.status = "completed";
        yield frame("response.function_call_arguments.done", {
          item_id: tool.id,
          output_index: tool.index,
          arguments: tool.arguments,
        });
        yield frame("response.output_item.done", {
          output_index: tool.index,
          item: tool.item,
        });
        pushOutput(tool);
      };

      for await (const event of events) {
        switch (event.type) {
          case "reasoning": {
            let current: ReasoningState | null = reasoning;
            if (!current) {
              const created: ReasoningState = {
                id: randomToken("rs_", 24),
                index: nextIndex++,
                text: "",
                open: true,
                item: { id: "", type: "reasoning", summary: [] },
              };
              created.item.id = created.id;
              reasoning = created;
              current = created;
              yield frame("response.output_item.added", {
                output_index: current.index,
                item: { id: current.id, type: "reasoning", summary: [] },
              });
            }
            current.text += event.delta;
            current.item.summary = [
              { type: "summary_text", text: current.text },
            ];
            if (current.open) {
              yield frame("response.reasoning_summary_text.delta", {
                item_id: current.id,
                output_index: current.index,
                summary_index: 0,
                delta: event.delta,
              });
            }
            break;
          }
          case "text": {
            if (reasoning?.open) yield* closeReasoning();
            let current: MessageState | null = message;
            if (!current) {
              const created: MessageState = {
                id: randomToken("msg_", 24),
                index: nextIndex++,
                text: "",
                open: true,
                item: {
                  id: "",
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              };
              created.item.id = created.id;
              message = created;
              current = created;
              yield frame("response.output_item.added", {
                output_index: current.index,
                item: {
                  id: current.id,
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              });
              yield frame("response.content_part.added", {
                item_id: current.id,
                output_index: current.index,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              });
            }
            current.text += event.delta;
            current.item.status = "in_progress";
            current.item.content = [
              { type: "output_text", text: current.text, annotations: [] },
            ];
            if (current.open) {
              yield frame("response.output_text.delta", {
                item_id: current.id,
                output_index: current.index,
                content_index: 0,
                delta: event.delta,
              });
            }
            break;
          }
          case "tool": {
            // A message content block must be closed before tool calls start.
            if (message?.open) yield* closeMessage();
            if (reasoning?.open) yield* closeReasoning();
            let tool = toolItems.get(event.index);
            if (!tool) {
              tool = {
                id: randomToken("fc_", 24),
                index: nextIndex++,
                callId: event.id ?? randomToken("call_", 24),
                name: event.name ?? "",
                arguments: "",
                open: true,
                item: {},
              };
              tool.item = {
                id: tool.id,
                type: "function_call",
                call_id: tool.callId,
                name: tool.name,
                arguments: "",
                status: "in_progress",
              };
              toolItems.set(event.index, tool);
              yield frame("response.output_item.added", {
                output_index: tool.index,
                item: tool.item,
              });
            } else {
              if (event.id) tool.callId = event.id;
              if (event.name) tool.name = event.name;
              tool.item.call_id = tool.callId;
              tool.item.name = tool.name;
            }
            if (event.argumentsDelta) {
              tool.arguments += event.argumentsDelta;
              tool.item.arguments = tool.arguments;
              yield frame("response.function_call_arguments.delta", {
                item_id: tool.id,
                output_index: tool.index,
                delta: event.argumentsDelta,
              });
            }
            break;
          }
          case "usage": {
            usage = { ...(usage ?? {}), ...event.usage };
            break;
          }
          case "error": {
            errorMessage = event.message;
            errorCode = event.code;
            break;
          }
          case "finish":
          case "start":
          default:
            break;
        }
      }

      if (errorMessage !== null) {
        yield frame("response.failed", {
          response: {
            ...responseSnapshot("failed", []),
            error: {
              code: errorCode ?? "upstream_error",
              message: errorMessage,
            },
          },
        });
        return;
      }

      if (reasoning?.open) yield* closeReasoning();
      if (message?.open) yield* closeMessage();
      for (const tool of [...toolItems.values()].sort(
        (a, b) => a.index - b.index,
      )) {
        yield* closeTool(tool);
      }

      const output = outputs
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.item);

      yield frame("response.completed", {
        response: {
          ...responseSnapshot("completed", output),
          usage: responseUsage(
            usage,
            ctx.request,
            message?.text ?? "",
            reasoning?.text ?? "",
          ),
        },
      });
    };

    return sseResponse(frames());
  },

  async renderComplete(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Promise<Response> {
    const collected = await collectEvents(events, {
      model: ctx.model,
      id: resolveResponseId(ctx),
      created: ctx.created,
    });

    const output: JsonObject[] = [];

    if (collected.reasoning) {
      output.push({
        id: randomToken("rs_", 24),
        type: "reasoning",
        summary: [{ type: "summary_text", text: collected.reasoning }],
      });
    }

    // The real API always includes a message item unless the turn is pure
    // tool calls; mirror that even for empty text.
    if (collected.text || collected.toolCalls.length === 0) {
      output.push({
        id: randomToken("msg_", 24),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: collected.text, annotations: [] },
        ],
      });
    }

    for (const tool of collected.toolCalls) {
      output.push({
        id: randomToken("fc_", 24),
        type: "function_call",
        call_id: tool.id || randomToken("call_", 24),
        name: tool.name,
        arguments: tool.arguments || "{}",
        status: "completed",
      });
    }

    return jsonResponse({
      id: resolveResponseId(ctx),
      object: "response",
      created_at: ctx.created,
      status: "completed",
      model: ctx.model,
      output,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      parallel_tool_calls: ctx.request.parallel_tool_calls ?? true,
      temperature: ctx.request.temperature ?? null,
      tool_choice: ctx.request.tool_choice ?? "auto",
      tools: ctx.request.tools ?? [],
      usage: responseUsage(
        collected.usage,
        ctx.request,
        collected.text,
        collected.reasoning,
      ),
    });
  },

  renderModels(models: ModelInfo[], _req: Request): Response {
    return jsonResponse({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created: model.created,
        owned_by: model.ownedBy,
        name: model.name,
        description: model.description,
        context_length: model.contextLength,
        max_output_tokens: model.maxOutputTokens,
        capabilities: model.capabilities,
        pricing: { prompt: "0", completion: "0" },
      })),
    });
  },

  renderError(status: number, message: string, code?: string): Response {
    return jsonResponse(
      {
        error: {
          message,
          type: status >= 500 ? "upstream_error" : "invalid_request_error",
          code: code ?? null,
        },
      },
      status,
    );
  },
};
