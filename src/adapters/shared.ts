/**
 * Helpers shared by downstream adapters: IDs, JSON/SSE responses, and content
 * conversion between OpenAI's wire format and other provider formats.
 */

import type { OpenAITool } from "../types.ts";

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function randomToken(prefix: string, length = 24): string {
  const alphabet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix}${out}`;
}

/** OpenAI content value -> plain text (for non-multimodal conversions). */
export function openAIContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text;
        if (typeof obj.content === "string") return obj.content;
      }
      return "";
    })
    .join("");
}

export function toOpenAITool(tool: {
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  strict?: boolean;
}): OpenAITool | undefined {
  if (!tool.name) return undefined;
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined && tool.description !== ""
        ? { description: tool.description }
        : {}),
      parameters:
        (tool.parameters as Record<string, unknown> | undefined) ??
        (tool.input_schema as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

export function mapFinishReason(
  reason: string | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

export function parseStreamFlag(value: unknown): boolean {
  return value === true || value === "true";
}
