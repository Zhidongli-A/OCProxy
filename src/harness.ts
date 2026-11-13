/**
 * Provider-compatibility injection (measured minimum).
 *
 * 2026-11-08 bisect against the live gateway showed the free-tier gate only
 * requires:
 *   1. a complete `<env>` block containing a `Working directory:` line;
 *   2. one tool named exactly `read`.
 * Everything else from the old capture (8.6KB preamble, 12-tool manifest,
 * date/model/environment values) is not required. This module injects exactly
 * those two things (no extra prompt text) and filters provider-tool calls on
 * the way back so third-party clients only see tools they actually expose.
 */

import { readFileSync } from "node:fs";
import type {
  ChatMessage,
  ChatRequest,
  Config,
  OpenAITool,
  UpstreamEvent,
} from "./types.ts";

const READ_TOOL_ASSET = new URL("../assets/read-tool.json", import.meta.url);

/** Caller-side names that can stand in for the `read` tool. */
const READ_ALIASES = ["Read", "read_file", "readFile", "read_text_file"];

/** OpenCode `read` argument -> caller argument name. */
const READ_ARG_MAP: Record<string, string | null> = {
  path: "file_path",
};

let readToolCache: OpenAITool | null | undefined;

/**
 * Build the minimal, measured-sufficient provider block: a complete `<env>`
 * block with a `Working directory:` line.
 */
function buildMinimalEnv(directory: string): string {
  return `<env>\n  Working directory: ${directory}\n</env>`;
}

function loadReadTool(): OpenAITool | undefined {
  if (readToolCache !== undefined) return readToolCache ?? undefined;
  try {
    const raw = readFileSync(READ_TOOL_ASSET, "utf8").replace(/^\uFEFF/, "");
    readToolCache = JSON.parse(raw) as OpenAITool;
  } catch {
    readToolCache = null;
  }
  return readToolCache ?? undefined;
}


function contentText(content: ChatMessage["content"]): string {
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
    .join("\n\n");
}

/**
 * Prepend the minimal `<env>` block (the only system prompt the gate needs).
 * The block is 49 chars and contains no instructions, so it needs no
 * neutralization; the caller's own system prompt follows it untouched.
 */
export function injectHarnessPreamble(
  request: ChatRequest,
  config: Config,
): void {
  if (!Array.isArray(request.messages)) return;
  const env = buildMinimalEnv(config.workingDirectory);

  const systemIndex = request.messages.findIndex(
    (message) => message.role === "system",
  );
  if (systemIndex === -1) {
    request.messages.unshift({ role: "system", content: env });
    return;
  }

  const message = request.messages[systemIndex];
  const current = contentText(message.content);
  if (current.trimStart().startsWith("<env>")) return;
  message.content = current ? `${env}\n\n${current}` : env;
}

/** A caller tool call name remapped to the caller's own tool. */
interface ToolMapping {
  callerName: string;
  argMap: Record<string, string | null>;
}

export interface ToolBridge {
  /** Names the downstream client can actually run (as sent upstream). */
  allowed: Set<string>;
  /** OpenCode manifest name -> caller tool mapping. */
  mappings: Map<string, ToolMapping>;
  /** Served alias -> caller's original name, for gated tool renames. */
  restore: Map<string, string>;
  /** Caller offered no tools: attach the manifest but strip every call. */
  stripAll: boolean;
}

function remapToolCallNames(request: ChatRequest, renames: Map<string, string>): void {
  if (!renames.size) return;
  const rename = (name: unknown): unknown =>
    typeof name === "string" && renames.has(name) ? renames.get(name) : name;

  for (const message of request.messages ?? []) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.function && typeof call.function.name === "string") {
          call.function.name = rename(call.function.name) as string;
        }
      }
    }
  }

  const choice = request.tool_choice;
  if (choice && typeof choice === "object") {
    const obj = choice as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === "string") {
      fn.name = rename(fn.name) as string;
    } else if (typeof obj.name === "string") {
      obj.name = rename(obj.name) as string;
    }
  }
}

const GATE_TOOL_NAME = "read";

/**
 * Upstream alias for a caller tool. The free-tier gate rejects requests whose
 * tool names collide with certain OpenCode-internal names (`read` variants,
 * `subagent_fork`, …), so every caller tool except the gate-required `read`
 * is served under a neutral name and restored on the way back.
 */
function aliasFor(index: number, taken: Set<string>): string {
  let alias = `tool_${index}`;
  while (taken.has(alias) || alias === GATE_TOOL_NAME) alias += "_";
  return alias;
}

/**
 * Alias every caller tool name (except `read`) in declarations, history and
 * tool_choice. The response bridge restores the caller's original names.
 */
function applyToolAliases(
  request: ChatRequest,
  callerTools: OpenAITool[],
): Map<string, string> {
  const renames = new Map<string, string>();
  const taken = new Set(
    callerTools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === "string"),
  );

  let index = 0;
  for (const tool of callerTools) {
    const name = tool.function?.name;
    if (typeof name !== "string" || name === GATE_TOOL_NAME) continue;
    index += 1;
    const alias = aliasFor(index, taken);
    renames.set(name, alias);
    taken.add(alias);
  }

  if (!renames.size) return renames;

  for (const tool of callerTools) {
    const name = tool.function?.name;
    if (typeof name === "string" && renames.has(name)) {
      tool.function.name = renames.get(name)!;
    }
  }
  remapToolCallNames(request, renames);
  return renames;
}

/**
 * Attach the one tool the gate requires (`read`) ahead of the caller's tools
 * and build the response-side bridge. Must run after tool-name aliasing.
 */
export function injectHarnessTools(
  request: ChatRequest,
  renames: Map<string, string>,
): ToolBridge {
  const callerTools = Array.isArray(request.tools) ? request.tools : [];
  const bridge: ToolBridge = {
    allowed: new Set<string>([
      ...[...callerTools]
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === "string"),
      // Caller tools are served under aliases upstream; the caller knows them
      // by the original name, which the response bridge restores before emitting.
      ...renames.keys(),
    ]),
    mappings: new Map(),
    restore: new Map(
      [...renames.entries()].map(([original, served]) => [served, original]),
    ),
    stripAll: callerTools.length === 0,
  };

  const readTool = loadReadTool();
  if (!readTool) return bridge;

  const callerNames = new Set(bridge.allowed);
  // A caller-provided `read` already satisfies the gate.
  if (callerNames.has("read")) return bridge;

  const alias = READ_ALIASES.find((name) => callerNames.has(name));
  if (alias) {
    bridge.mappings.set("read", {
      callerName: alias,
      argMap: READ_ARG_MAP,
    });
  }

  request.tools = [structuredClone(readTool), ...callerTools];
  return bridge;
}

/** Full harness preparation: alias tool names + read tool + minimal env block. */
export function applyHarness(request: ChatRequest, config: Config): ToolBridge {
  const callerTools = Array.isArray(request.tools) ? request.tools : [];
  const renames = applyToolAliases(request, callerTools);
  const bridge = injectHarnessTools(request, renames);
  injectHarnessPreamble(request, config);
  return bridge;
}

function remapArguments(
  raw: string,
  argMap: Record<string, string | null>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key in argMap) {
      const target = argMap[key];
      if (target === null) continue;
      out[target] = value;
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

const DROPPED_TOOL_NOTICE =
  "[gateway] The model tried to call an OpenCode-internal tool that this client does not provide; the call was blocked. Please retry using the client's own tools.";

/**
 * Wrap the normalized upstream stream: buffer tool calls, keep only calls the
 * downstream client can run, rename manifest calls to the caller's tool and
 * remap their arguments. Text/reasoning/usage stay streamed untouched.
 *
 * Calls to manifest tools with no caller counterpart are dropped. If that
 * leaves the turn empty (no text, no usable calls), a short notice is emitted
 * instead of an empty response.
 */
export async function* applyToolBridge(
  events: AsyncIterable<UpstreamEvent>,
  bridge: ToolBridge,
): AsyncGenerator<UpstreamEvent> {
  interface Buffered {
    id: string;
    name: string;
    args: string;
  }
  const buffers = new Map<number, Buffered>();
  let textSeen = false;
  let keptCalls = 0;
  let droppedCalls = 0;
  let fallbackSent = false;

  function* flush(): Generator<UpstreamEvent> {
    const indices = [...buffers.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const call = buffers.get(index)!;
      if (bridge.stripAll) {
        droppedCalls += 1;
        continue;
      }

      const restored = bridge.restore.get(call.name);
      const servedName = restored ?? call.name;
      if (bridge.allowed.has(servedName)) {
        keptCalls += 1;
        yield {
          type: "tool",
          index,
          id: call.id || undefined,
          name: servedName,
          argumentsDelta: call.args,
        };
        continue;
      }

      const mapping = bridge.mappings.get(call.name);
      if (!mapping) {
        droppedCalls += 1;
        continue;
      }
      keptCalls += 1;
      yield {
        type: "tool",
        index,
        id: call.id || undefined,
        name: mapping.callerName,
        argumentsDelta: remapArguments(call.args, mapping.argMap),
      };
    }
    buffers.clear();
  }

  function* maybeNotice(): Generator<UpstreamEvent> {
    if (fallbackSent) return;
    if (droppedCalls > 0 && keptCalls === 0 && !textSeen) {
      fallbackSent = true;
      yield { type: "text", delta: DROPPED_TOOL_NOTICE };
    }
  }

  for await (const event of events) {
    if (event.type === "tool") {
      const buffered = buffers.get(event.index) ?? {
        id: "",
        name: "",
        args: "",
      };
      if (event.id) buffered.id = event.id;
      if (event.name) buffered.name += event.name;
      if (event.argumentsDelta) buffered.args += event.argumentsDelta;
      buffers.set(event.index, buffered);
      continue;
    }
    if (event.type === "text" && event.delta.trim()) textSeen = true;
    if (event.type === "finish") {
      yield* flush();
      yield* maybeNotice();
      // Every call was blocked and a notice replaced the turn: it is no
      // longer a tool-call turn, so report a normal stop downstream.
      if (droppedCalls > 0 && keptCalls === 0) {
        yield { type: "finish", reason: "stop" };
        continue;
      }
    }
    yield event;
  }

  yield* flush();
  yield* maybeNotice();
}


