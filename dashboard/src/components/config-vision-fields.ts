import type { FieldDef } from "@/components/config-sections";

export const VISION_GENERAL_FIELDS: FieldDef[] = [
  {
    key: "vision_strategy",
    label: "Strategy",
    kind: "select",
    description:
      'Controls when the proxy intercepts image-bearing requests to generate text descriptions via a vision model. "never" disables interception entirely; "catalog" uses a cache-first strategy where vision-capable models process images themselves and only non-capable models get descriptions; "always" forces interception for all requests regardless of model capability. Default: catalog.',
    options: [
      { value: "never", label: "Never" },
      { value: "catalog", label: "Catalog" },
      { value: "always", label: "Always" },
    ],
    restartRequired: true,
    required: true,
  },
  {
    key: "vision_model",
    label: "Model",
    kind: "select",
    description:
      "Model used to generate image descriptions during vision interception. Must be a vision-capable model. The dropdown is populated from /v1/models/info at runtime. Default: umans-flash.",
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
      "System prompt sent to the vision model when generating image descriptions. Changing this increments vision_prompt_version to bust the cache. Default: a built-in prompt that produces exhaustive, structured descriptions (image type, OCR, visual elements, data/charts, contextual clues, quality notes).",
    restartRequired: true,
    required: true,
  },
  {
    key: "vision_prompt_version",
    label: "Prompt Version",
    kind: "number",
    description:
      "Version tag for the vision prompt. Bump this when you edit vision_prompt to invalidate cached descriptions generated with an older prompt. Cached entries with a mismatched version are treated as misses. Default: 2.",
    restartRequired: true,
    required: true,
    min: 1,
  },
  {
    key: "vision_max_images",
    label: "Max Images",
    kind: "number",
    description:
      "Maximum number of images processed in a single vision interception request. Additional images in the same request are ignored. Range: 1–100. Default: 5.",
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
      "Maximum number of tokens the vision model may generate per image description. Higher values allow more detailed descriptions at the cost of latency. Range: 1–200,000. Default: 4,096.",
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
      'Reasoning effort for the vision model. "none" disables reasoning; "low"/"medium"/"high" increase reasoning depth at the cost of latency. Selecting "Default (null)" uses the model\'s built-in default. Default: none.',
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
      "Timeout for vision interception requests in milliseconds. 0 means no timeout — the proxy waits indefinitely for the vision model to respond. Default: 0 (no timeout).",
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
      "Maximum number of entries in the in-memory vision description cache. When the cache is full, oldest entries are evicted. Must be ≥ 100. Default: 1,000.",
    restartRequired: true,
    required: true,
    min: 100,
  },
  {
    key: "vision_cache_ttl_ms",
    label: "Cache TTL",
    kind: "number",
    description:
      "Time-to-live for vision description cache entries in milliseconds. Expired entries are treated as misses and re-fetched from the vision model. Must be ≥ 1,000 ms. Default: 604,800,000 ms (7 days).",
    restartRequired: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "vision_cache_max_rows",
    label: "Cache Max Rows",
    kind: "number",
    description:
      "Maximum number of rows in the persistent (on-disk SQLite) vision cache. When the table is full, oldest entries are evicted. Must be ≥ 100. Default: 10,000.",
    restartRequired: true,
    min: 100,
  },
  {
    key: "vision_persistent_cache",
    label: "Persistent Cache",
    kind: "boolean",
    description:
      "When on, vision description cache is persisted to disk (SQLite) and survives restarts. When off, cache is in-memory only and lost on restart. Default: true.",
    restartRequired: true,
  },
  {
    key: "vision_concurrency",
    label: "Concurrency",
    kind: "number",
    description:
      "Maximum number of concurrent vision interception requests. Higher values allow parallel image processing but increase upstream load. Range: 1–20. Default: 1.",
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
      "Maximum width or height (in pixels) for preprocessed images. Images exceeding this in either dimension are downscaled proportionally before being sent to the vision model. Range: 256–8,192. Default: 2,048 px.",
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
      'JPEG encoding quality (1–100) for preprocessed images when vision_image_format is "jpeg". Higher values produce sharper images at larger file sizes. Ignored when format is "png". Range: 1–100. Default: 92.',
    restartRequired: true,
    min: 1,
    max: 100,
  },
  {
    key: "vision_image_format",
    label: "Image Format",
    kind: "select",
    description:
      'Output image format for preprocessed images sent to the vision model. "jpeg" produces smaller payloads with lossy compression; "png" is lossless but larger. Default: png.',
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
      'OpenAI-style image detail level sent to the vision model. "low" uses a single low-resolution pass; "high" processes the image at higher detail (more tokens, more accurate); "auto" lets the model decide based on image size. Default: high.',
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
      "Maximum number of pending vision requests to batch together into a single processing cycle. Higher values increase throughput under load but add latency for the first request in the batch. Must be ≥ 1. Default: 50.",
    restartRequired: true,
    min: 1,
  },
  {
    key: "vision_intent_strategy",
    label: "Intent Strategy",
    kind: "select",
    description:
      'Controls how the vision model is prompted once interception is decided. "off" uses a generic OCR prompt for all images. "slotted" includes the user\'s adjacent question in the prompt. "crafted" makes an LLM call to reformulate single-image questions into a neutral, focused image-description request (Strategy D). "auto" lets a deterministic triage function pick the best strategy per request based on adjacent text, image count, and tool-result status. Default: auto.',
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
      "When on, multi-image requests with explicit image references are split into per-image sub-questions via a cheap LLM call (DecoVQA+ pattern). Each sub-question is neutrally phrased to defend against Visual Sycophancy. Results are cached in-memory per batch key. Any failure falls back to the slotted strategy. Default: true.",
    restartRequired: false,
  },
  {
    key: "vision_decomposition_timeout_ms",
    label: "Decomposition Timeout",
    kind: "number",
    description:
      "Timeout for the decomposition LLM call in milliseconds. Must be ≥ 100. If the call times out, the request falls back to the slotted strategy. Default: 3,000 ms.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_crafting_timeout_ms",
    label: "Crafting Timeout",
    kind: "number",
    description:
      "Timeout for the crafting LLM call (Strategy D) in milliseconds. Must be ≥ 100. If the call times out, the request falls back to the slotted strategy. Default: 3,000 ms.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_adjacent_text_max_chars",
    label: "Adjacent Text Max Chars",
    kind: "number",
    description:
      "Maximum number of characters to extract from text blocks adjacent to an image block, used as context for triage and crafted/decomposed prompts. 0 disables extraction. Default: 500.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_recent_messages_count",
    label: "Recent Messages Count",
    kind: "number",
    description:
      "Number of recent user messages to include in the vision context (VisionContext.recentMessages). 0 disables inclusion. Default: 6.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_system_prompt_max_chars",
    label: "System Prompt Max Chars",
    kind: "number",
    description:
      "Maximum number of characters to extract from the original system prompt for vision context. 0 disables extraction. Default: 1,000.",
    restartRequired: false,
    min: 0,
  },
];
