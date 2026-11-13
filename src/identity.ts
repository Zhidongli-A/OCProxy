/**
 * OpenCode V2 client identity synthesis.
 *
 * Zen's free tier only serves requests that look like they came from the
 * OpenCode V2 client (V1 UAs have been rejected since 2026-10-26). The
 * fingerprint below is captured from OpenCode 2.2.5:
 *
 *   User-Agent:                    opencode/latest/2.2.5/cli
 *   b3 / traceparent:              its Effect tracer's B3 + W3C forms
 *   x-opencode-client:             cli
 *   x-opencode-project:            sha1("directory:" + dir)  (or git remote)
 *   x-opencode-session:            ses_<12 hex><14 base62>
 *   x-opencode-session-id:         same
 *   x-session-affinity:            same
 *   x-session-id:                  same
 *   Authorization:                 Bearer public
 *
 * The session id shape is checked by Zen: OpenCode builds it as
 * (Date.now() * 0x1000 + per-ms counter) with the low 12 bits bit-inverted
 * for sessions, so a random 12-hex prefix is rejected. `opencodeID()`
 * reproduces that generator exactly.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ChatMessage, ChatRequest, Config } from "./types.ts";
import { computeProjectId } from "./environment.ts";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastStamp = 0;
let counter = 0;

/**
 * An id the way OpenCode's `packages/schema/src/identifier.ts` makes one:
 * 12 hex of `Date.now() * 0x1000 + counter` (inverted for descending ids such
 * as sessions), then 14 random base62 characters.
 */
export function opencodeID(
  prefix: string,
  descending: boolean,
  now: number = Date.now(),
): string {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter += 1;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

/** Whether a value has OpenCode's real session id shape (small counter). */
export function realSessionID(value: string | null | undefined): boolean {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return Boolean(match) && 0xfff - Number.parseInt(match![1], 16) < 16;
}

export function generateSessionId(now: number = Date.now()): string {
  return opencodeID("ses", true, now);
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function generateMessageId(prefix = "chatcmpl"): string {
  const random = randomBytes(24);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}-${tail}`;
}

/** Keep one synthetic session per conversation so turns share cache routing. */
const SESSIONS = new Map<string, string>();
const MAX_SESSIONS = 1000;

function firstUserText(messages: ChatMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const first = messages.find((message) => message.role === "user");
  if (!first) return undefined;
  if (typeof first.content === "string") return first.content || undefined;
  if (!Array.isArray(first.content)) return undefined;
  const text = first.content
    .map((part) => {
      if (part && typeof part === "object") {
        const value = (part as Record<string, unknown>).text;
        if (typeof value === "string") return value;
      }
      return "";
    })
    .join("");
  return text || undefined;
}

/**
 * Per-process salt. OpenCode's free tier charges a session id; once a session
 * has been answered 429 it stays burned even after switching egress IP, so a
 * restarted relay must mint fresh ids (community finding: opencode2api #159/#160).
 * A running process still keeps one stable session per conversation.
 */
const PROCESS_SALT = randomBytes(16).toString("hex");

function conversationKey(request: ChatRequest): string | undefined {
  const text = firstUserText(request.messages);
  if (!text) return undefined;
  return createHash("sha256")
    .update(`ses\0${PROCESS_SALT}\0${text}`)
    .digest("hex");
}

export function sessionForConversation(
  request: ChatRequest,
): string | undefined {
  const key = conversationKey(request);
  if (!key) return undefined;
  let session = SESSIONS.get(key);
  if (session) {
    // refresh LRU position
    SESSIONS.delete(key);
  } else {
    session = generateSessionId();
    if (SESSIONS.size >= MAX_SESSIONS) {
      const oldest = SESSIONS.keys().next().value;
      if (oldest !== undefined) SESSIONS.delete(oldest);
    }
  }
  SESSIONS.set(key, session);
  return session;
}

/**
 * Drop the cached session for a conversation after a 429, so the next retry
 * mints a fresh session instead of replaying a burned one.
 */
export function forgetConversationSession(request: ChatRequest): void {
  const key = conversationKey(request);
  if (key) SESSIONS.delete(key);
}

/* -------------------------------------------------------------------------- */
/* Trace headers                                                              */
/* -------------------------------------------------------------------------- */

const TRACES = new Map<string, string>();

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * OpenCode's Effect tracer emits both B3 and W3C trace headers: one trace id
 * per conversation, a fresh span per request.
 */
export function traceHeaders(session: string): { b3: string; traceparent: string } {
  let trace = TRACES.get(session);
  if (trace) {
    TRACES.delete(session);
  } else {
    trace = randomHex(16);
    if (TRACES.size >= MAX_SESSIONS) {
      const oldest = TRACES.keys().next().value;
      if (oldest !== undefined) TRACES.delete(oldest);
    }
  }
  TRACES.set(session, trace);
  const span = randomHex(8);
  return {
    b3: `${trace}-${span}-1-${randomHex(8)}`,
    traceparent: `00-${trace}-${span}-01`,
  };
}

/* -------------------------------------------------------------------------- */
/* Outbound headers                                                           */
/* -------------------------------------------------------------------------- */

export interface UpstreamIdentity {
  /** Downstream session hint, only reused when it has OpenCode's own shape. */
  sessionId?: string;
  requestId?: string;
}

export interface BuildHeadersOptions {
  stream?: boolean;
  identity?: UpstreamIdentity;
  extraHeaders?: Record<string, string>;
}

function resolveSession(config: Config, identity?: UpstreamIdentity): string {
  if (config.sessionAffinity === "off") return generateSessionId();
  const candidate = identity?.sessionId;
  if (candidate && realSessionID(candidate)) return candidate;
  return generateSessionId();
}

/**
 * Build the outbound headers exactly as OpenCode 2.2.5 sends them, in its
 * order, so no extra header marks the request as not-OpenCode traffic.
 */
export function buildUpstreamHeaders(
  config: Config,
  options: BuildHeadersOptions = {},
): Headers {
  const headers = new Headers();
  const session = resolveSession(config, options.identity);
  const trace = traceHeaders(session);
  const projectId =
    config.opencodeProjectId || computeProjectId(config.workingDirectory);

  headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  headers.set("content-type", "application/json");
  headers.set("user-agent", config.userAgent);
  headers.set("b3", trace.b3);
  headers.set("traceparent", trace.traceparent);
  headers.set("x-opencode-client", config.opencodeClient);
  headers.set("x-opencode-project", projectId);
  headers.set("x-opencode-session", session);
  headers.set("x-opencode-session-id", session);
  headers.set("x-session-affinity", session);
  headers.set("x-session-id", session);

  if (options.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) {
      headers.set(key, value);
    }
  }

  return headers;
}

const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
] as const;

/**
 * Reuse a downstream session hint only when it is a real OpenCode session id
 * (Zen validates the shape). Otherwise the caller falls back to a synthetic
 * conversation-derived id.
 */
export function downstreamIdentity(req: Request): UpstreamIdentity | undefined {
  for (const name of SESSION_HEADER_NAMES) {
    const value = req.headers.get(name)?.trim();
    if (value && realSessionID(value)) return { sessionId: value };
  }
  return undefined;
}
