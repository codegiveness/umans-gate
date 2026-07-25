import type { FieldDef } from "@/components/config-sections";

export const VISION_GENERAL_FIELDS: FieldDef[] = [
  {
    key: "vision_strategy",
    label: "Strategy",
    kind: "select",
    description:
      "Controls when the proxy intercepts image-bearing requests for vision description. 'never' disables interception; 'catalog' (default) intercepts only for models lacking vision support (background mode — first request with new image passes through, cache populated for next); 'always' forces interception for all requests. Default: catalog.",
    options: [
      { value: "never", label: "Never" },
      { value: "catalog", label: "Catalog" },
      { value: "always", label: "Always" },
    ],
    restartRequired: true,
    required: true,
    tooltip:
      "When strategy is 'catalog' (default), vision processing runs in background mode: the first request with a new image is forwarded upstream untouched, and the cache is populated for the next request. Switch to 'always' to intercept synchronously (adds latency to first-image requests).",
  },
  {
    key: "vision_model",
    label: "Model",
    kind: "select",
    description:
      "Model used to generate image descriptions during vision interception. Dropdown populated from /v1/models/info at runtime. Default: umans-flash.",
    restartRequired: true,
    required: true,
  },
];

export const VISION_TUNING_FIELDS: FieldDef[] = [
  {
    key: "vision_prompt",
    label: "Prompt",
    kind: "textarea",
    description:
      "System prompt sent to the vision model when generating image descriptions. Cached entries with a mismatched vision_prompt_version are treated as misses — bump version manually when you change this prompt to invalidate old cache entries. Default: built-in prompt producing exhaustive, structured descriptions (image type, OCR, visual elements, data/charts, contextual clues, quality notes).",
    restartRequired: true,
    required: true,
  },
  {
    key: "vision_prompt_version",
    label: "Prompt Version",
    kind: "number",
    description:
      "Version tag for the vision prompt. Bump manually when you edit vision_prompt to invalidate cached descriptions generated with an older prompt. Entries with mismatched version are treated as misses. Default: 2.",
    restartRequired: true,
    required: true,
    min: 1,
  },
  {
    key: "vision_max_images",
    label: "Max Images",
    kind: "number",
    description:
      "Maximum images processed in a single vision interception request. Additional images ignored. Default: 5.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 100,
  },
  {
    key: "vision_max_description_tokens",
    label: "Max Description Tokens",
    kind: "number",
    description:
      "Maximum tokens the vision model may generate per image description. Higher = more detail, more latency. Default: 4,096.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 200000,
  },
  {
    key: "vision_reasoning_effort",
    label: "Reasoning Effort",
    kind: "select",
    description:
      "Reasoning effort for the vision model. 'none' disables reasoning; low/medium/high increase reasoning depth at cost of latency. 'Default (null)' uses the model's built-in default. Default: none.",
    options: [
      { value: "", label: "Default (null)" },
      { value: "none", label: "None" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    nullable: true,
    restartRequired: true,
  },
  {
    key: "vision_timeout_ms",
    label: "Timeout",
    kind: "number",
    description:
      "Timeout for vision interception requests. 0 = no timeout (wait indefinitely). Default: 0.",
    restartRequired: true,
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "vision_cache_size",
    label: "Cache Size",
    kind: "number",
    description:
      "Maximum entries in the in-memory vision description cache. Oldest evicted when full. Default: 1,000.",
    restartRequired: true,
    required: true,
    min: 100,
  },
  {
    key: "vision_cache_ttl_ms",
    label: "Cache TTL",
    kind: "number",
    description:
      "TTL for vision description cache entries. Expired entries treated as misses and re-fetched. Default: 604,800,000 ms (7 days).",
    restartRequired: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "vision_cache_max_rows",
    label: "Cache Max Rows",
    kind: "number",
    description:
      "Maximum rows in the persistent (on-disk SQLite) vision cache. Oldest evicted when table is full. Default: 10,000.",
    restartRequired: true,
    min: 100,
  },
  {
    key: "vision_persistent_cache",
    label: "Persistent Cache",
    kind: "boolean",
    description:
      "When on, vision description cache is persisted to SQLite and survives restarts. When off, in-memory only. Default: on.",
    restartRequired: true,
  },
  {
    key: "vision_concurrency",
    label: "Concurrency",
    kind: "number",
    description:
      "Maximum concurrent vision interception requests. Higher = parallel image processing but more upstream load. Default: 1.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 20,
  },
  {
    key: "vision_max_dimension",
    label: "Max Dimension",
    kind: "number",
    description:
      "Maximum width or height for preprocessed images. Images exceeding this are downscaled proportionally before sending to the vision model. Default: 2,048 px.",
    restartRequired: true,
    min: 256,
    max: 8192,
    suffix: "px",
  },
  {
    key: "vision_jpeg_quality",
    label: "JPEG Quality",
    kind: "number",
    description:
      "JPEG encoding quality for preprocessed images when vision_image_format is 'jpeg'. Higher = sharper, larger files. Ignored when format is 'png'. Default: 92.",
    restartRequired: true,
    min: 1,
    max: 100,
  },
  {
    key: "vision_image_format",
    label: "Image Format",
    kind: "select",
    description:
      "Output image format for preprocessed images sent to the vision model. 'jpeg' = smaller payloads, lossy; 'png' = lossless, larger. Default: png.",
    options: [
      { value: "jpeg", label: "JPEG" },
      { value: "png", label: "PNG" },
    ],
    restartRequired: true,
  },
  {
    key: "vision_image_detail",
    label: "Image Detail",
    kind: "select",
    description:
      "OpenAI-style image detail level sent to the vision model. 'low' = single low-res pass; 'high' = higher detail (more tokens, more accurate); 'auto' = model decides based on image size. Default: high.",
    options: [
      { value: "auto", label: "Auto" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ],
    restartRequired: true,
  },
  {
    key: "vision_pending_max_batch",
    label: "Pending Max Batch",
    kind: "number",
    description:
      "Maximum pending vision requests batched into a single processing cycle. Higher = more throughput under load, more latency for first request in batch. Default: 50.",
    restartRequired: true,
    min: 1,
  },
  {
    key: "vision_intent_strategy",
    label: "Intent Strategy",
    kind: "select",
    description:
      "Controls how the vision model is prompted once interception is decided. 'off' = generic OCR prompt for all images; 'slotted' = includes user's adjacent question in prompt; 'crafted' = LLM call reformulates single-image questions into neutral, focused image-description requests (Strategy D); 'auto' (default) = deterministic triage picks best strategy per request based on adjacent text, image count, and tool-result status.",
    options: [
      { value: "off", label: "Off (generic only)" },
      { value: "slotted", label: "Slotted" },
      { value: "crafted", label: "Crafted" },
      { value: "auto", label: "Auto (triage decides)" },
    ],
    restartRequired: false,
  },
  {
    key: "vision_decomposition_enabled",
    label: "Decomposition Enabled",
    kind: "boolean",
    description:
      "When on, multi-image requests with explicit image references are split into per-image sub-questions via a cheap LLM call (DecoVQA+ pattern). Sub-questions are neutrally phrased to defend against Visual Sycophancy. Results cached in-memory per batch key. Any failure falls back to slotted strategy. Default: on.",
    restartRequired: false,
  },
  {
    key: "vision_decomposition_timeout_ms",
    label: "Decomposition Timeout",
    kind: "number",
    description:
      "Timeout for the decomposition LLM call. On timeout, request falls back to slotted strategy. Default: 3,000 ms.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_crafting_timeout_ms",
    label: "Crafting Timeout",
    kind: "number",
    description:
      "Timeout for the crafting LLM call (Strategy D). On timeout, request falls back to slotted strategy. Default: 3,000 ms.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_adjacent_text_max_chars",
    label: "Adjacent Text Max Chars",
    kind: "number",
    description:
      "Maximum characters extracted from text blocks adjacent to an image block, used as context for triage and crafted/decomposed prompts. 0 = no extraction. Default: 500.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_recent_messages_count",
    label: "Recent Messages Count",
    kind: "number",
    description:
      "Number of recent user messages included in vision context (VisionContext.recentMessages). 0 = disabled. Default: 6.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_system_prompt_max_chars",
    label: "System Prompt Max Chars",
    kind: "number",
    description:
      "Maximum characters extracted from the original system prompt for vision context. 0 = no extraction. Default: 1,000.",
    restartRequired: false,
    min: 0,
  },
];
