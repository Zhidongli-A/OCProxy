/**
 * Server-Sent Events helpers.
 *
 * A small, dependency-free SSE parser (works with arbitrarily split byte
 * chunks and CRLF/CR/LF line endings) plus encoders used by the downstream
 * adapters.
 */

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** Parse a `ReadableStream<Uint8Array>` into SSE messages. */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  const flush = function* (): Generator<SSEMessage> {
    // Per the SSE spec an event with no data lines is never dispatched.
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    const message: SSEMessage = {
      data: dataLines.join("\n"),
    };
    if (eventName !== undefined) message.event = eventName;
    if (id !== undefined) message.id = id;
    if (retry !== undefined) message.retry = retry;
    dataLines = [];
    eventName = undefined;
    id = undefined;
    retry = undefined;
    yield message;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF / CR so a single newline scan is enough.
      let newlineIndex: number;
      while ((newlineIndex = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A trailing lone CR may be the first half of a CRLF split across
        // chunks; wait for the next read unless the stream ended.
        if (
          newlineIndex === buffer.length - 1 &&
          buffer.charCodeAt(newlineIndex) === 13
        ) {
          break;
        }
        const rawLine = buffer.slice(0, newlineIndex);
        const sepLength = buffer.startsWith("\r\n", newlineIndex) ? 2 : 1;
        buffer = buffer.slice(newlineIndex + sepLength);

        if (rawLine === "") {
          yield* flush();
          continue;
        }
        if (rawLine.startsWith(":")) continue; // comment / keep-alive

        const colon = rawLine.indexOf(":");
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
        let value2 = colon === -1 ? "" : rawLine.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);

        switch (field) {
          case "data":
            dataLines.push(value2);
            break;
          case "event":
            eventName = value2;
            break;
          case "id":
            id = value2;
            break;
          case "retry": {
            const parsed = Number.parseInt(value2, 10);
            if (Number.isFinite(parsed)) retry = parsed;
            break;
          }
          default:
            break;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      // Process a trailing line that was not newline-terminated.
      const line = buffer;
      buffer = "";
      if (line.startsWith("data:")) {
        let v = line.slice(5);
        if (v.startsWith(" ")) v = v.slice(1);
        dataLines.push(v);
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      }
    }
    yield* flush();
  } finally {
    reader.releaseLock();
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
  }
}

/** Encode one SSE frame. `data` may already be a JSON string. */
export function encodeSSE(data: string, event?: string, id?: string): string {
  let out = "";
  if (id !== undefined) out += `id: ${id}\n`;
  if (event !== undefined) out += `event: ${event}\n`;
  for (const line of data.split("\n")) out += `data: ${line}\n`;
  return out + "\n";
}

/** Build a streaming Response from a generator of already-framed SSE strings. */
export function sseResponse(
  frames: AsyncIterable<string>,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
    cancel() {
      // The `for await` loop above observes generator return on cancellation.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...extraHeaders,
    },
  });
}
