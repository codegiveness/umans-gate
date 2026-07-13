// SSE parsing helpers for Anthropic and OpenAI streaming responses.

import type { AnthropicSseEvent, OpenAIStreamChunk, TimedChunk } from "./types.js";

/**
 * Parse an Anthropic SSE response from timed chunks into events with
 * timing markers. Each event gets the timestamp of the chunk it was found
 * in, fixing the old 1:1 round-robin assignment that broke when a single
 * HTTP chunk contained multiple SSE events.
 */
export function parseAnthropicSse(chunks: TimedChunk[]): AnthropicSseEvent[] {
  const events: AnthropicSseEvent[] = [];

  const parseEventBlock = (block: string, evType: string): AnthropicSseEvent | null => {
    const lines = block.split("\n");
    let type = evType;
    let dataLine: string | null = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        type = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      }
    }
    if (dataLine == null) return null;
    if (dataLine === "[DONE]") return null;
    try {
      const parsed = JSON.parse(dataLine) as Record<string, unknown>;
      return {
        type: (parsed.type as string) ?? type,
        ...parsed,
      };
    } catch {
      return null;
    }
  };

  let buf = "";
  let evType = "";
  for (const { text, time } of chunks) {
    buf += text;
    // Process complete SSE event blocks (delimited by \n\n).
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Extract event type from the block if present.
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) evType = line.slice(7).trim();
      }
      const ev = parseEventBlock(block, evType);
      if (ev) {
        ev.received_at = time;
        events.push(ev);
      }
      idx = buf.indexOf("\n\n");
    }
  }
  // Parse any remaining incomplete block in the buffer.
  if (buf.trim()) {
    const ev = parseEventBlock(buf, evType);
    if (ev) {
      const lastTime = chunks[chunks.length - 1]?.time;
      if (lastTime != null) ev.received_at = lastTime;
      events.push(ev);
    }
  }
  return events;
}

/**
 * Parse an OpenAI SSE response from timed chunks into chunks with timing
 * markers. Each chunk is parsed individually and its timestamp is assigned
 * to all events found within it.
 */
export function parseOpenAiSse(chunks: TimedChunk[]): OpenAIStreamChunk[] {
  const result: OpenAIStreamChunk[] = [];

  const parseDataLine = (data: string): OpenAIStreamChunk | null => {
    if (data === "[DONE]") return null;
    try {
      return JSON.parse(data) as OpenAIStreamChunk;
    } catch {
      return null;
    }
  };

  let buf = "";
  for (const { text, time } of chunks) {
    buf += text;
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) {
          const ch = parseDataLine(line.slice(6));
          if (ch) {
            ch.received_at = time;
            result.push(ch);
          }
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
  if (buf.trim()) {
    for (const line of buf.split("\n")) {
      if (line.startsWith("data: ")) {
        const ch = parseDataLine(line.slice(6));
        if (ch) {
          const lastTime = chunks[chunks.length - 1]?.time;
          if (lastTime != null) ch.received_at = lastTime;
          result.push(ch);
        }
      }
    }
  }
  return result;
}
