/**
 * Event-stream collection helpers shared by every downstream adapter.
 */

import type {
  ChatMessage,
  ChatRequest,
  Collected,
  CollectedToolCall,
  UpstreamEvent,
  Usage,
} from "./types.ts";
import { generateMessageId } from "./identity.ts";

export async function collectEvents(
  events: AsyncIterable<UpstreamEvent>,
  fallback: { model: string; id?: string; created?: number },
): Promise<Collected> {
  const collected: Collected = {
    id: fallback.id ?? generateMessageId(),
    model: fallback.model,
    created: fallback.created ?? Math.floor(Date.now() / 1000),
    text: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };

  let usageSeen = false;
  const toolCalls = new Map<number, CollectedToolCall>();

  for await (const event of events) {
    switch (event.type) {
      case "start": {
        collected.id = event.id || collected.id;
        collected.model = event.model || collected.model;
        collected.created = event.created || collected.created;
        break;
      }
      case "text":
        collected.text += event.delta;
        break;
      case "reasoning":
        collected.reasoning += event.delta;
        break;
      case "tool": {
        const existing = toolCalls.get(event.index) ?? {
          index: event.index,
          id: "",
          name: "",
          arguments: "",
        };
        if (event.id) existing.id = event.id;
        if (event.name) existing.name += event.name;
        if (event.argumentsDelta) existing.arguments += event.argumentsDelta;
        toolCalls.set(event.index, existing);
        break;
      }
      case "usage": {
        usageSeen = true;
        const usage = event.usage;
        if (usage.promptTokens !== undefined) {
          collected.usage.promptTokens = usage.promptTokens;
        }
        if (usage.completionTokens !== undefined) {
          collected.usage.completionTokens = usage.completionTokens;
        }
        if (usage.totalTokens !== undefined) {
          collected.usage.totalTokens = usage.totalTokens;
        }
        if (usage.reasoningTokens !== undefined) {
          collected.usage.reasoningTokens = usage.reasoningTokens;
        }
        if (usage.cachedTokens !== undefined) {
          collected.usage.cachedTokens = usage.cachedTokens;
        }
        break;
      }
      case "finish":
        collected.finishReason = event.reason;
        break;
      case "error":
        break;
    }
  }

  collected.toolCalls = [...toolCalls.values()].sort((a, b) => a.index - b.index);

  if (!usageSeen) {
    collected.usage = estimateUsage(collected.text, collected.reasoning);
  } else {
    if (!collected.usage.totalTokens) {
      collected.usage.totalTokens =
        collected.usage.promptTokens + collected.usage.completionTokens;
    }
  }

  return collected;
}

/** Rough token estimate (~4 chars/token) used when upstream omits usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateUsage(output: string, reasoning = ""): Usage {
  const completion = estimateTokens(output) + estimateTokens(reasoning);
  return {
    promptTokens: 0,
    completionTokens: completion,
    totalTokens: completion,
  };
}

export function estimatePromptTokens(request: ChatRequest): number {
  const text = request.messages
    .map((message) => messageText(message))
    .join("\n");
  return estimateTokens(text);
}

export function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}
