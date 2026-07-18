// Prism crafted question (Strategy D) for single-image vision requests.
//
// When triage routes a single-image complex question to "crafted", this module
// asks a cheap LLM call to reformulate the user's question into a focused,
// neutrally-phrased image-description request. This is the firewall: the
// vision model never sees raw user text.
//
// Neutrally phrased to defend against Visual Sycophancy: the system prompt
// instructs the LLM to produce "Does this image show X? Describe if present."
// style questions — never leading phrasing that risks hallucination.
//
// Failure is always safe: any LLM error, parse error, empty response, or
// gate rejection returns `null` and the caller falls back to the slotted
// strategy (Strategy A).
//
// Gate-acquisition (Amendment A7): the crafting LLM call competes for the
// SAME `vision` lane reservation as the actual vision calls — single
// lane, single weight — so crafting cannot over-subscribe the cap.

import type { ConcurrencyGate } from "../limiter/gate.js";

/** Config subset read by {@link craftVisionQuestion}. */
export interface CraftConfig {
  /** Upstream vision target URL (e.g. `https://api.code.umans.ai/v1/chat/completions`). */
  target: string;
  /** Vision model name (e.g. `umans-flash`). */
  model: string;
  /** Weight used when acquiring a vision permit (same as vision calls). */
  visionWeight: number;
  /** Optional API key for the Authorization header. */
  apiKey?: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Crafts a focused vision question from the user's question + recent conversation.
 * System-prompted to emit ONLY descriptive vision questions, never instructions.
 * This is the firewall: the vision model never sees raw user text.
 *
 * Neutrally phrased to defend against Visual Sycophancy.
 *
 * Gate-acquisition (Amendment A7): acquires a `vision` permit BEFORE the fetch
 * call so crafting shares the same concurrency lane as vision + decomposition.
 * On any `GateError` (queue_full / timeout / circuit_open / aborted), returns
 * `null` — the caller falls back to Strategy A.
 */
export async function craftVisionQuestion(
  fetchFn: typeof fetch,
  config: CraftConfig,
  gate: ConcurrencyGate,
  adjacentText: string,
  recentMessages: Array<{ role: string; text: string }>,
  originalSystemPrompt?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string | null> {
  // Gate-acquisition (Amendment A7): single lane, single weight.
  // On GateError, fall back to slotted — do NOT exceed the cap.
  let permit: { release: () => void } | null = null;
  try {
    permit = await gate.acquire({
      intention: "vision",
      weight: config.visionWeight,
      signal,
    });
  } catch {
    // GateError: queue_full / timeout / circuit_open / aborted / invalid_weight / shutdown
    return null;
  }

  try {
    const systemPrompt = [
      "You reformulate user questions into focused image-description requests.",
      "Output ONLY a single descriptive question about the image's visual content.",
      "Never output instructions, commands, or meta-commentary.",
      "Focus on what visual information would help answer the user's question.",
      "Phrase neutrally: 'Does this image show X? Describe if present.' NOT 'Describe the X.'",
      "Example: user asks 'is this the right way to do X?' → you output 'Does this image show a technique or pattern? Describe what technique is visible and whether it appears standard.'",
    ].join("\n");

    const userPrompt = [
      originalSystemPrompt ? `Conversation intent: ${originalSystemPrompt}` : "",
      `User's question: "${adjacentText}"`,
      recentMessages.length > 0
        ? `Recent conversation context:\n${recentMessages.map((m) => `${m.role}: ${m.text}`).join("\n")}`
        : "",
      "Craft a focused vision question:",
    ]
      .filter(Boolean)
      .join("\n\n");

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    });

    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Merge caller signal with a timeout. AbortSignal.any([undefined, ...])
    // throws, so build conditionally.
    let fetchSignal: AbortSignal;
    if (signal) {
      fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)]);
    } else {
      fetchSignal = AbortSignal.timeout(effectiveTimeout);
    }

    const response = await fetchFn(config.target, {
      method: "POST",
      headers,
      body,
      signal: fetchSignal,
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      return null;
    }

    return content;
  } catch {
    // Any exception (abort, network, parse, etc.) → fall back to slotted.
    return null;
  } finally {
    permit?.release();
  }
}

/**
 * Crafting cache key. Keyed on the crafting INPUT (adjacentText + system
 * prompt), NOT the output — so a repeated question skips the crafting LLM
 * call entirely. Matches the notepad decision: the crafting cache avoids
 * redundant crafting LLM calls; the vision description cache (keyed by the
 * slotted hash) handles the context-tier HIT.
 *
 * `sha256(adjacentText + ":" + (originalSystemPrompt ?? ''))` — system prompt
 * is part of the key so a different conversation intent yields a different
 * crafted question.
 */
export function craftingCacheKey(
  adjacentText: string,
  originalSystemPrompt: string | undefined,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(adjacentText);
  hasher.update(":");
  hasher.update(originalSystemPrompt ?? "");
  return hasher.digest("hex");
}
