/**
 * OpenAI Chat Completions adapter (`POST /v1/chat/completions`).
 */

import type {
  Adapter,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  RenderContext,
  UpstreamEvent,
} from "../types.ts";
import { badRequest } from "../errors.ts";
import { collectEvents, estimatePromptTokens } from "../collect.ts";
import { encodeSSE, sseResponse } from "../sse.ts";
import { generateMessageId } from "../identity.ts";
import {
  jsonResponse,
  mapFinishReason,
  parseStreamFlag,
} from "./shared.ts";

export function parseOpenAIChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.model !== "string" || !raw.model.trim()) {
    throw badRequest("Missing required field: model");
  }
  if (!Array.isArray(raw.messages)) {
    throw badRequest("Missing required field: messages");
  }

  const messages: ChatMessage[] = raw.messages
    .filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object"),
    )
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "user";
      const content = message.content;
      if (
        content !== null &&
        typeof content !== "string" &&
        !Array.isArray(content)
      ) {
        throw badRequest("Each message content must be a string, array, or null.");
      }
      return {
        ...message,
        role,
        content: (content ?? null) as ChatMessage["content"],
      } as ChatMessage;
    });

  const request: ChatRequest = {
    ...raw,
    model: raw.model,
    messages,
    stream: parseStreamFlag(raw.stream),
  };

  // Keep the canonical body free of transport-only fields.
  delete (request as Record<string, unknown>).stream_options;

  return request;
}

export const openAIAdapter: Adapter = {
  format: "openai",

  parseRequest: parseOpenAIChatRequest,

  isStream(body: unknown): boolean {
    return Boolean(
      body && typeof body === "object" && parseStreamFlag((body as Record<string, unknown>).stream),
    );
  },

  renderStream(
    events: AsyncIterable<UpstreamEvent>,
    ctx: RenderContext,
  ): Response {
    const id = ctx.requestId || generateMessageId();
    const created = ctx.created;
    const model = ctx.model;

    const frames = async function* (): AsyncGenerator<string> {
      let sentRole = false;
      let finishReason: string | null = null;
      let usage: Record<string, number> | undefined;

      for await (const event of events) {
        switch (event.type) {
          case "text": {
            const delta: Record<string, unknown> = sentRole
              ? { content: event.delta }
              : { role: "assistant", content: event.delta };
            sentRole = true;
            yield encodeSSE(
              JSON.stringify(chunkPayload(id, created, model, delta, null)),
            );
            break;
          }
          case "reasoning": {
            const delta: Record<string, unknown> = sentRole
              ? { reasoning_content: event.delta }
              : { role: "assistant", reasoning_content: event.delta };
            sentRole = true;
            yield encodeSSE(
              JSON.stringify(chunkPayload(id, created, model, delta, null)),
            );
            break;
          }
          case "tool": {
            const fn: Record<string, unknown> = {};
            if (event.name) fn.name = event.name;
            if (event.argumentsDelta) fn.arguments = event.argumentsDelta;
            const toolCall: Record<string, unknown> = {
              index: event.index,
              type: "function",
              function: fn,
            };
            if (event.id) toolCall.id = event.id;
            const delta: Record<string, unknown> = sentRole
              ? { tool_calls: [toolCall] }
              : { role: "assistant", tool_calls: [toolCall] };
            sentRole = true;
            yield encodeSSE(
              JSON.stringify(chunkPayload(id, created, model, delta, null)),
            );
            break;
          }
          case "finish": {
            finishReason = event.reason;
            break;
          }
          case "usage": {
            // Emitted after the finish chunk below; buffered here.
            usage = {
              prompt_tokens: event.usage.promptTokens ?? 0,
              completion_tokens: event.usage.completionTokens ?? 0,
              total_tokens: event.usage.totalTokens ?? 0,
            };
            if (event.usage.reasoningTokens !== undefined) {
              usage.reasoning_tokens = event.usage.reasoningTokens;
            }
            break;
          }
          default:
            break;
        }
      }

      yield encodeSSE(
        JSON.stringify(
          chunkPayload(id, created, model, {}, mapFinishReason(finishReason)),
        ),
      );

      if (usage) {
        const promptTokens =
          usage.prompt_tokens || estimatePromptTokens(ctx.request);
        yield encodeSSE(
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: usage.completion_tokens,
              total_tokens:
                usage.total_tokens || promptTokens + usage.completion_tokens,
              ...(usage.reasoning_tokens !== undefined
                ? {
                    completion_tokens_details: {
                      reasoning_tokens: usage.reasoning_tokens,
                    },
                  }
                : {}),
            },
          }),
        );
      }

      yield "data: [DONE]\n\n";
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

    const message: Record<string, unknown> = {
      role: "assistant",
      content: collected.text || (collected.toolCalls.length > 0 ? null : ""),
    };
    if (collected.reasoning) message.reasoning_content = collected.reasoning;
    if (collected.toolCalls.length > 0) {
      message.tool_calls = collected.toolCalls.map((tool) => ({
        id: tool.id || generateMessageId("call"),
        type: "function",
        function: {
          name: tool.name,
          arguments: tool.arguments || "{}",
        },
      }));
    }

    const promptTokens = collected.usage.promptTokens || estimatePromptTokens(ctx.request);
    const completionTokens = collected.usage.completionTokens;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: collected.usage.totalTokens || promptTokens + completionTokens,
      ...(collected.usage.reasoningTokens !== undefined
        ? {
            completion_tokens_details: {
              reasoning_tokens: collected.usage.reasoningTokens,
            },
          }
        : {}),
    };

    return jsonResponse({
      id: collected.id,
      object: "chat.completion",
      created: collected.created,
      model: ctx.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: mapFinishReason(collected.finishReason),
          logprobs: null,
        },
      ],
      usage,
      system_fingerprint: "OCProxy",
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

function chunkPayload(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };
}
