import type { FieldDef } from "@/components/config-sections";

export const VISION_GENERAL_FIELDS: FieldDef[] = [
  {
    key: "vision_strategy",
    label: "Strategy",
    kind: "select",
    description:
      "When the proxy should describe images for the model. 'never' = don't touch images. 'catalog' = only when the model can't see images. 'always' = describe every image.",
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
    description: "Which model describes the images.",
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
      "The instructions sent to the vision model when describing images. Bump the version number below when you change this so old descriptions are regenerated.",
    restartRequired: true,
    required: true,
  },
  {
    key: "vision_prompt_version",
    label: "Prompt Version",
    kind: "number",
    description:
      "A number tag for your prompt. Raise it when you edit the prompt so old descriptions are redone. Default: 2.",
    restartRequired: true,
    required: true,
    min: 1,
  },
  {
    key: "vision_max_images",
    label: "Max Images",
    kind: "number",
    description: "Most images described in one request. Extra images are ignored. Default: 20.",
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
      "Longest description the vision model can write per image. More tokens = more detail but slower. Default: 4,096.",
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
      "How hard the vision model thinks before answering. 'none' = fastest, 'high' = deepest. 'Default' lets the model pick. Default: none.",
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
    description: "How long to wait for the vision model. 0 = wait forever. Default: 0.",
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
      "How many image descriptions to keep in memory. Oldest are dropped when full. Default: 1,000.",
    restartRequired: true,
    required: true,
    min: 100,
  },
  {
    key: "vision_cache_ttl_ms",
    label: "Cache TTL",
    kind: "number",
    description: "How long an image description is kept before it's redone. Default: 7 days.",
    restartRequired: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "vision_cache_max_rows",
    label: "Cache Max Rows",
    kind: "number",
    description:
      "Most image descriptions saved on disk. Oldest are dropped when full. Default: 10,000.",
    restartRequired: true,
    min: 100,
  },
  {
    key: "vision_persistent_cache",
    label: "Persistent Cache",
    kind: "boolean",
    description:
      "When on, image descriptions survive restarts. When off, they're forgotten on restart. Default: on.",
    restartRequired: true,
  },
  {
    key: "vision_concurrency",
    label: "Concurrency",
    kind: "number",
    description:
      "How many images to describe at the same time. Higher = faster but more API load. Default: 4.",
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
      "Biggest width or height for images sent to the vision model. Bigger images are shrunk first. Default: 2,048 px.",
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
      "Quality for JPEG images sent to the vision model. Higher = sharper but bigger files. Only used when format is JPEG. Default: 92.",
    restartRequired: true,
    min: 1,
    max: 100,
  },
  {
    key: "vision_image_format",
    label: "Image Format",
    kind: "select",
    description:
      "Picture format sent to the vision model. JPEG = smaller, slight quality loss. PNG = perfect quality, bigger. Default: PNG.",
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
      "Detail level for images sent to the vision model. 'low' = quick and fuzzy. 'high' = sharp but uses more tokens. 'auto' = model decides. Default: high.",
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
      "Most image tasks processed together. Higher = faster under load but the first task waits longer. Default: 50.",
    restartRequired: true,
    min: 1,
  },
  {
    key: "vision_intent_strategy",
    label: "Intent Strategy",
    kind: "select",
    description:
      "How the vision model is prompted. 'off' = generic description without context. 'slotted' = includes your nearby question. 'crafted' = rewrites your question to focus on the image. 'auto' (default) = proxy picks the best one for each request.",
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
      "When on, requests with multiple images are split into one question per image. Better answers for multi-image questions. Falls back to slotted if it fails. Default: on.",
    restartRequired: false,
  },
  {
    key: "vision_decomposition_timeout_ms",
    label: "Decomposition Timeout",
    kind: "number",
    description:
      "How long to wait for the split-up step. If it takes too long, falls back to slotted. Default: 3 seconds.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_crafting_timeout_ms",
    label: "Crafting Timeout",
    kind: "number",
    description:
      "How long to wait for the question-rewrite step. If it takes too long, falls back to slotted. Default: 3 seconds.",
    restartRequired: false,
    min: 100,
    suffix: "ms",
  },
  {
    key: "vision_adjacent_text_max_chars",
    label: "Adjacent Text Max Chars",
    kind: "number",
    description:
      "How much nearby text to grab as context when describing an image. 0 = none. Default: 500.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_recent_messages_count",
    label: "Recent Messages Count",
    kind: "number",
    description: "How many of your recent messages to include as context. 0 = none. Default: 6.",
    restartRequired: false,
    min: 0,
  },
  {
    key: "vision_system_prompt_max_chars",
    label: "System Prompt Max Chars",
    kind: "number",
    description:
      "How much of the original system prompt to include as context. 0 = none. Default: 1,000.",
    restartRequired: false,
    min: 0,
  },
];
