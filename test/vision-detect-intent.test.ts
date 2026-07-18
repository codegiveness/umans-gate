// Tests for intent-aware ImagePart extraction (Amendment A1).
//
// Validates the four new fields on ImagePart:
//   - adjacentText:        concatenated sibling text blocks (capped at maxChars)
//   - isToolResult:        true when nested in Anthropic tool_result.content[]
//   - positionInBatch:     1-based, depth-first tree-walk order (matches
//                          replaceImageBlocks cursor order — critical for
//                          label↔description correspondence)
//   - batchSize:           total images in the same message
//   - originalSystemPrompt: truncated prefix of the request's system prompt
//                           (request-scoped — same value on every ImagePart)
//
// Run: bun test test/vision-detect-intent.test.ts

import { describe, expect, test } from "bun:test";
import { findAnthropicImageParts, findOpenAIImageParts } from "../src/vision/detect.js";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const PNG_B64 = "iVBORw0KGgo=";

// ─── OpenAI: single image ────────────────────────────────────────────────────

describe("OpenAI intent extraction", () => {
  test("1. single image: adjacentText, positionInBatch=1, batchSize=1, originalSystemPrompt set", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    const p = parts[0];
    expect(p.mediaType).toBe("image/png");
    expect(p.encoding).toBe("base64");
    expect(p.data).toBe(PNG_B64);
    expect(p.adjacentText).toBe("what is this?");
    expect(p.isToolResult).toBe(false);
    expect(p.positionInBatch).toBe(1);
    expect(p.batchSize).toBe(1);
    expect(p.originalSystemPrompt).toBe("You are helpful.");
  });

  test("2. multi-image (one message): shared adjacentText, positionInBatch 1 and 2, batchSize=2", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "describe these" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(2);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[1].positionInBatch).toBe(2);
    expect(parts[0].batchSize).toBe(2);
    expect(parts[1].batchSize).toBe(2);
    expect(parts[0].adjacentText).toBe("describe these");
    expect(parts[1].adjacentText).toBe("describe these");
    expect(parts[0].originalSystemPrompt).toBe("sys");
    expect(parts[1].originalSystemPrompt).toBe("sys");
  });

  test("3. multi-message: each message is its own batch with positionInBatch starting at 1", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "second" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(3);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].batchSize).toBe(1);
    expect(parts[0].adjacentText).toBe("first");
    expect(parts[1].positionInBatch).toBe(1);
    expect(parts[1].batchSize).toBe(2);
    expect(parts[1].adjacentText).toBe("second");
    expect(parts[2].positionInBatch).toBe(2);
    expect(parts[2].batchSize).toBe(2);
    // No system prompt in this body.
    expect(parts[0].originalSystemPrompt).toBeUndefined();
  });

  test("4. no system prompt → originalSystemPrompt undefined", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBeUndefined();
  });

  test("5. system prompt truncation: 2000-char prompt → truncated to 1000", () => {
    const longPrompt = "A".repeat(2000);
    const body = {
      messages: [
        { role: "system", content: longPrompt },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt?.length).toBe(1000);
    expect(parts[0].originalSystemPrompt).toBe("A".repeat(1000));
  });

  test("6. image-only message (no text blocks): adjacentText undefined", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].adjacentText).toBeUndefined();
  });

  test("7. maxChars=0 → originalSystemPrompt and adjacentText undefined", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body, 0);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBeUndefined();
    expect(parts[0].adjacentText).toBeUndefined();
    // Structural fields still populated.
    expect(parts[0].isToolResult).toBe(false);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].batchSize).toBe(1);
  });

  test("8. system prompt as content[] array of text blocks is concatenated", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "part1" },
            { type: "text", text: "part2" },
          ],
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBe("part1part2");
  });
});

// ─── Anthropic: single image, multi-image, tool_result ───────────────────────

describe("Anthropic intent extraction", () => {
  test("9. single image: adjacentText, positionInBatch=1, batchSize=1, isToolResult=false", () => {
    const body = {
      system: "You are Claude.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    const p = parts[0];
    expect(p.mediaType).toBe("image/png");
    expect(p.encoding).toBe("base64");
    expect(p.data).toBe(PNG_B64);
    expect(p.adjacentText).toBe("what is this?");
    expect(p.isToolResult).toBe(false);
    expect(p.positionInBatch).toBe(1);
    expect(p.batchSize).toBe(1);
    expect(p.originalSystemPrompt).toBe("You are Claude.");
  });

  test("10. multi-image: positionInBatch in tree-walk order, batchSize correct", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "two images" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(2);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[1].positionInBatch).toBe(2);
    expect(parts[0].batchSize).toBe(2);
    expect(parts[1].batchSize).toBe(2);
    expect(parts[0].adjacentText).toBe("two images");
    expect(parts[1].adjacentText).toBe("two images");
    // No body.system.
    expect(parts[0].originalSystemPrompt).toBeUndefined();
  });

  test("11. tool_result-nested image: isToolResult=true, positionInBatch assigned, adjacentText undefined", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "result above" },
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: PNG_B64 },
                },
              ],
            },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].isToolResult).toBe(true);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].batchSize).toBe(1);
    expect(parts[0].adjacentText).toBeUndefined();
  });

  test("12. mixed top-level + tool_result images: tree-walk order, batchSize counts both", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "ctx" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "TOP" } },
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "NESTED" },
                },
              ],
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AFTER" } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(3);
    // Depth-first order: TOP → NESTED → AFTER (matches replaceImageBlocks).
    expect(parts[0].data).toBe("TOP");
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].isToolResult).toBe(false);
    expect(parts[0].adjacentText).toBe("ctx");
    expect(parts[1].data).toBe("NESTED");
    expect(parts[1].positionInBatch).toBe(2);
    expect(parts[1].isToolResult).toBe(true);
    expect(parts[1].adjacentText).toBeUndefined();
    expect(parts[2].data).toBe("AFTER");
    expect(parts[2].positionInBatch).toBe(3);
    expect(parts[2].isToolResult).toBe(false);
    expect(parts[2].adjacentText).toBe("ctx");
    // batchSize includes tool_result-nested images.
    expect(parts[0].batchSize).toBe(3);
    expect(parts[1].batchSize).toBe(3);
    expect(parts[2].batchSize).toBe(3);
  });

  test("13. body.system as string → originalSystemPrompt extracted", () => {
    const body = {
      system: "system-string",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBe("system-string");
  });

  test("14. body.system as content[] array → text blocks concatenated", () => {
    const body = {
      system: [
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBe("alphabeta");
  });

  test("15. no body.system → originalSystemPrompt undefined", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBeUndefined();
  });

  test("16. maxChars=0 → originalSystemPrompt and adjacentText undefined", () => {
    const body = {
      system: "sys",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "ctx" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body, 0);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt).toBeUndefined();
    expect(parts[0].adjacentText).toBeUndefined();
    expect(parts[0].isToolResult).toBe(false);
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].batchSize).toBe(1);
  });

  test("17. system prompt truncation: 2000-char prompt → truncated to 1000", () => {
    const longPrompt = "B".repeat(2000);
    const body = {
      system: longPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].originalSystemPrompt?.length).toBe(1000);
    expect(parts[0].originalSystemPrompt).toBe("B".repeat(1000));
  });

  test("18. url source: extracted with encoding=url, positionInBatch correct", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].encoding).toBe("url");
    expect(parts[0].data).toBe("https://example.com/cat.jpg");
    expect(parts[0].adjacentText).toBe("see this");
    expect(parts[0].positionInBatch).toBe(1);
    expect(parts[0].batchSize).toBe(1);
  });
});

// ─── Backward compatibility: existing fields unchanged ──────────────────────

describe("backward compatibility", () => {
  test("existing ImagePart fields (mediaType/encoding/data) are unaffected on OpenAI", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].mediaType).toBe("image/png");
    expect(parts[0].encoding).toBe("base64");
    expect(parts[0].data).toBe("iVBORw0KGgo=");
  });

  test("empty body / no messages returns empty array (OpenAI + Anthropic)", () => {
    expect(findOpenAIImageParts({})).toEqual([]);
    expect(findAnthropicImageParts({})).toEqual([]);
    expect(findOpenAIImageParts(null)).toEqual([]);
    expect(findAnthropicImageParts(null)).toEqual([]);
  });
});
