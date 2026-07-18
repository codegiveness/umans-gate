// Selective decomposition (DecoVQA+ pattern) for multi-image vision requests.
//
// When triage routes a multi-image batch with explicit image references to
// "decomposed", this module asks a cheap LLM call to split the user's question
// into N per-image sub-questions — one per image, in image order. Each
// sub-question is neutrally phrased to defend against Visual Sycophancy:
// "Does this image contain X? Describe if present." NOT "Describe the X".
//
// Failure is always safe: any LLM error, parse error, length mismatch, or
// gate rejection returns `{ decomposed: false }` and the caller falls back to
// the slotted strategy (Strategy A).
//
// Gate-acquisition (Amendment A6): the decomposition LLM call competes for
// the SAME `vision` lane reservation as the actual vision calls — single
// lane, single weight — so decomposition cannot over-subscribe the cap.

import type { ConcurrencyGate } from "../limiter/gate.js";

/** Inputs to {@link decomposeIfNeeded}. */
export interface DecompositionInput {
  /** The user's original multi-image question (adjacent text from the batch). */
  userQuestion: string;
  /** Number of images in the batch. Must be > 1 for decomposition to run. */
  imageCount: number;
  /** The conversation's system prompt, if any (Amendment A6 — context for decomposition). */
  originalSystemPrompt?: string;
}

/** Result of {@link decomposeIfNeeded}. */
export interface DecompositionResult {
  /** Whether decomposition succeeded. When false, caller falls back to slotted. */
  decomposed: boolean;
  /** Per-image sub-questions, in image order. Only present when `decomposed === true`. */
  perImageQuestions?: string[];
}

/** Config subset read by {@link decomposeIfNeeded}. */
export interface DecomposeConfig {
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
 * Decide whether to decompose a multi-image question, and if so, produce
 * per-image sub-questions. Uses the DecoVQA+ pattern: classify (triage already
 * did this) then decompose.
 *
 * Neutrally phrased to defend against Visual Sycophancy: the system prompt
 * instructs the LLM to produce "Does this image contain X? Describe if present."
 * style sub-questions — never "Describe the X in this image" (leading phrasing
 * risks hallucination).
 *
 * Gate-acquisition (Amendment A6): acquires a `vision` permit BEFORE the fetch
 * call so decomposition shares the same concurrency lane as vision calls. On
 * any `GateError` (queue_full / timeout / circuit_open / aborted), returns
 * `{ decomposed: false }` — the caller falls back to slotted.
 */
export async function decomposeIfNeeded(
  fetchFn: typeof fetch,
  config: DecomposeConfig,
  gate: ConcurrencyGate,
  input: DecompositionInput,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<DecompositionResult> {
  // Fast path: single image never needs decomposition.
  if (input.imageCount <= 1) {
    return { decomposed: false };
  }

  // Gate-acquisition (Amendment A6): single lane, single weight.
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
    return { decomposed: false };
  }

  try {
    const systemPrompt = [
      "You decompose a multi-image user question into per-image sub-questions.",
      "Output ONLY a JSON array of strings, one sub-question per image, in image order (Image 1, Image 2, ...).",
      "Each sub-question must be neutrally phrased: 'Does this image contain X? Describe if present.'",
      "Never use leading phrasing like 'Describe the X' — that risks hallucination.",
      "If the question applies equally to all images, output a single sub-question repeated N times.",
      `The user sent ${input.imageCount} images. Output exactly ${input.imageCount} sub-questions.`,
    ].join("\n");

    const userPrompt = [
      input.originalSystemPrompt ? `Conversation intent: ${input.originalSystemPrompt}` : "",
      `User's question: "${input.userQuestion}"`,
      `The user sent ${input.imageCount} images. Output exactly ${input.imageCount} sub-questions.`,
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
      return { decomposed: false };
    }

    const json = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { decomposed: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { decomposed: false };
    }

    if (!Array.isArray(parsed) || parsed.length !== input.imageCount) {
      return { decomposed: false };
    }
    const subQuestions: string[] = [];
    for (const q of parsed) {
      if (typeof q !== "string" || q.length === 0) {
        return { decomposed: false };
      }
      subQuestions.push(q);
    }
    return { decomposed: true, perImageQuestions: subQuestions };
  } catch {
    // Any exception (abort, network, parse, etc.) → fall back to slotted.
    return { decomposed: false };
  } finally {
    permit?.release();
  }
}

/**
 * Decomposition cache key. Matches plan §7 decision + Amendment A6 line 1112:
 * `sha256(adjacentText + imageCount + (originalSystemPrompt ?? ''))`.
 *
 * The system prompt is part of the key so a different conversation intent
 * yields different sub-questions.
 */
export function decompositionCacheKey(
  adjacentText: string,
  imageCount: number,
  originalSystemPrompt: string | undefined,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(adjacentText);
  hasher.update(String(imageCount));
  hasher.update(originalSystemPrompt ?? "");
  return hasher.digest("hex");
}
