# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] - 2026-07-19

### Fixed

- **README: corrected the hot-reload blanket claim for `vision_*` fields**.
  The Hot Reload and Restart section previously stated that all `vision_*`
  fields require a server restart. This was inaccurate for the 7 intent-aware
  vision fields introduced in v0.3.2 (`vision_intent_strategy`,
  `vision_decomposition_enabled`, `vision_decomposition_timeout_ms`,
  `vision_crafting_timeout_ms`, `vision_adjacent_text_max_chars`,
  `vision_recent_messages_count`, `vision_system_prompt_max_chars`), which
  are hot-reloadable per `src/config/reload.ts` and marked
  `restartRequired: false` in the dashboard Config tab. The README now lists
  these 7 fields explicitly as hot-reloadable and qualifies the restart claim
  as applying to "most other `vision_*` fields."

## [0.3.3] - 2026-07-19

### Fixed

- **Dashboard Config tab: added 7 intent-aware vision fields**. The v0.3.2
  release added `vision_intent_strategy`, `vision_decomposition_enabled`,
  `vision_decomposition_timeout_ms`, `vision_crafting_timeout_ms`,
  `vision_adjacent_text_max_chars`, `vision_recent_messages_count`, and
  `vision_system_prompt_max_chars` to the backend (all hot-reloadable), but
  the dashboard Config tab was not updated to expose them — contradicting the
  README's "Dashboard-first" configuration guidance. All 7 fields now appear in
  the Vision section with descriptions, validation, and hot-reload support.
  The `VisionRawConfig` type in `dashboard/src/hooks/use-config.ts` was
  extended accordingly.
- **`docs/proxy-modifications.md`: stale `src/proxy.ts:161` reference**.
  The vision interception entry pointed at the wrong line in `proxy.ts`
  (the vision call is at lines 308-309, not 161). Replaced the brittle line
  number with a stable symbol reference to `processBody` /
  `processBodyCacheOnly` and documented the new intent-aware prompting
  pipeline.
- **`docs/ARCHITECTURE.md`: vision flow diagram missed the triage step**.
  The pipeline diagram and numbered list were updated to reflect the
  context-extraction and triage-routing steps added in v0.3.2.

## [0.3.2] - 2026-07-19

### Added

- **Intent-aware vision pipeline**: the vision handoff now triages each image
  request into one of four strategies — `generic`, `slotted`, `crafted`, or
  `decomposed` — based on the adjacent user text, image count, and whether the
  image is a tool result. A new `VISION_INTENT_STRATEGY` config gates the
  behavior: `off` (generic only), `slotted` (force slot strategy), `crafted`
  (force crafted questions for single-image), or `auto` (default — triage
  decides per-request). The triage function is pure and deterministic so the
  chosen strategy seeds the cache key without fragmentation.
- **Multi-image decomposition (DecoVQA+)**: when a multi-image request contains
  explicit image references (e.g. "compare the first and second image"), a
  cheap LLM call splits the user question into N per-image sub-questions, each
  neutrally phrased to defend against Visual Sycophancy. Gated by
  `VISION_DECOMPOSITION_ENABLED` (default `true`) with a configurable
  `VISION_DECOMPOSITION_TIMEOUT_MS` (default 3000ms). Results are cached
  in-memory per batch key so the same batch never pays twice. Failure is
  always safe — any error falls back to the slotted strategy.
- **Crafted question strategy (Strategy D)**: for single-image complex questions,
  an LLM call reformulates the user's question into a focused, neutrally-phrased
  image-description request. The vision model never sees raw user text, which
  defends against Visual Sycophancy. Gated by the `crafted` triage strategy
  with a configurable `VISION_CRAFTING_TIMEOUT_MS` (default 3000ms). Crafting
  results are cached in-memory per input key. Failure falls back to slotted.
- **Vision context extraction**: `ImagePart` now carries `adjacentText`,
  `isToolResult`, `positionInBatch`, `batchSize`, and `originalSystemPrompt`.
  These fields feed the triage function and the crafted/decomposition prompts.
  New config fields control extraction bounds: `VISION_ADJACENT_TEXT_MAX_CHARS`
  (default 500), `VISION_RECENT_MESSAGES_COUNT` (default 6), and
  `VISION_SYSTEM_PROMPT_MAX_CHARS` (default 1000). All hot-reloadable.

### Changed

- **New DB index on `vision_descriptions(image_hash)`**: speeds up persistent
  cache lookups for the two-tier cache hit path. Auto-applied on next startup
  via the existing migration.

### Fixed

- **CI test flakiness on v0.3.1**: two timing-sensitive vision tests
  (`vision-handoff-background-signal` and `vision-handoff-integration`) used
  fixed sleeps that could exceed the wait window under CI runner load. Both
  now poll for the actual condition with a 5s deadline instead of a single
  fixed sleep, matching the existing `waitForModelsRequest` pattern.

## [0.3.1] - 2026-07-18

### Added

- **Experimental `EXPERIMENT_STRIP_OMO_REMINDER` strip step**: a new opt-in
  experiment (`EXPERIMENT_STRIP_OMO_REMINDER`, default `false`) that removes
  oh-my-openagent's `[Category+Skill Reminder]` synthetic text block from
  `messages[0].content` on Anthropic requests before forwarding upstream. The
  injection (added by the `category-skill-reminder` hook in
  oh-my-openagent v4.18.x) splices a ~486-byte text block into the first
  user message on turn 2, invalidating the Anthropic prompt cache prefix
  and dropping cache hit rate to ~0% for 1-2 turns. Stripping it preserves
  cache stability. The step runs after all other stamp steps, is idempotent,
  preserves all other content blocks and `cache_control` breakpoints, and
  scans only the first message. Hot-reloadable.

### Changed

- **Dashboard Config tab: new experiment groups**: the Config tab now shows
  two new groups under the Stamp section — "ID Rewrite" (surfaces the
  existing `experiment_rewrite_ids` and `experiment_rewrite_ttl_ms` fields
  with descriptions) and "oh-my-openagent" (surfaces the new
  `experiment_strip_omo_reminder` toggle). Both groups are marked
  experimental. The `ExperimentRawConfig` type was added to the dashboard's
  config hook so these fields round-trip through save/reload.

## [0.3.0] - 2026-07-17

### Added

- **Experimental ID rewriting on 502/529**: a new opt-in experiment
  (`EXPERIMENT_REWRITE_IDS`, default `false`) that detects `overloaded_error`
  responses from the upstream and retries the request with rewritten
  opencode session IDs and `tool_use_ids`. Uses a deterministic salt-based
  rewrite with persistent SQLite mapping tables, automatic salt escalation on
  repeated 502s, and a configurable TTL (`EXPERIMENT_REWRITE_TTL_MS`, default
  1 hour). Both hot-reloadable. Eligible only for the `opencode` harness with
  a valid session ID.

### Changed

- **Gate borrows idle reservation slots**: when a vision (or main) intention
  has zero active and zero queued requests, its reserved slot is now
  borrowable by the other intention. This prevents idle vision reservations
  from permanently reducing effective main concurrency (e.g. main can now
  reach the full hard cap when vision is idle). The reservation is restored
  immediately when the owning intention has demand.
- **Usage snapshot now drives effective limit**: `usage.onChange` syncs
  `config.concurrencyHardCap` and `config.concurrencySoftLimit` from the
  live `/v1/usage` snapshot in-memory, so `applyEffectiveLimit()` reads
  authoritative upstream values instead of stale startup defaults. This
  fixes a race where the proxy could operate at the default limit (8)
  instead of the upstream-reported limit until an explicit config refresh.
- **Always reconcile limits on startup**: when `UMANS_API_KEY` is set, the
  proxy now always calls `refreshLimits()` on startup instead of only when
  `concurrencyHardCap <= 1`. The `<= 1` heuristic was stale after the
  default hard cap was raised to 16.

### Fixed

- **Burst concurrency test races**: `test/burst-concurrency.test.ts` now
  polls `effectiveLimit` via the gate API instead of using fixed sleeps,
  eliminating startup races that caused `peakInFlight` to exceed the
  upstream limit during the window before the first `/v1/usage` fetch
  completed. Hardcoded test proxy ports were removed to avoid stale-process
  conflicts.

## [0.2.2] - 2026-07-17

### Added

- **`USE_HARD_CAP` config toggle**: a new hot-reloadable boolean that
  selects which concurrency limit is the effective operating limit.
  When `false` (default), the effective limit is the soft limit (8);
  when `true`, the effective limit is the hard cap (16). Toggleable at
  runtime via the dashboard Config tab — no restart needed. The gate
  never grants beyond the selected limit.
- **`effectiveLimit` in `GateStats`**: the gate now reports the actual
  current operating limit (after priorityLow/boxing adjustments) in
  addition to `softLimit` and `hardCap`. The dashboard gate-status
  component uses this to display `active/effectiveLimit` and compute the
  utilization bar, giving an accurate picture of real concurrency headroom.

### Changed

- **Default concurrency raised**: `CONCURRENCY_HARD_CAP` default changed
  from `1` to `16`; `CONCURRENCY_SOFT_LIMIT` default changed from `1`
  to `8`. The effective limit defaults to the soft limit (8) unless
  `USE_HARD_CAP=true`. Both values remain auto-sized from `/v1/usage`
  when `UMANS_API_KEY` is set.
- **Dashboard Config tab — Hard Cap / Soft Limit are now read-only**:
  both fields are derived from `/v1/usage` and are no longer directly
  editable. Field-level refresh buttons were removed from these fields.
  Use the new "Use Hard Cap" toggle to switch the effective limit.
- **Dashboard gate-status display**: the primary counter now shows
  `active/effectiveLimit` (labeled "cap") instead of
  `active/hardCap` (labeled "hard cap"). The tooltip shows all four
  values: active, effective, hard cap, soft limit.
- **Dashboard capture-list queue counter**: the header counter now
  shows the count of captures in `enqueued` or `streaming` state
  (actual in-flight) instead of the gate's `active` count, making the
  queue depth reflect client-visible state rather than gate internals.

### Fixed

- **Permit leak on client abort**: when a client disconnected
  mid-stream, the `onAbort` handler called `flushCapture()` but did
  not call `releasePermit()`, leaving the gate's active count stuck
  at 1 indefinitely. `onAbort` now releases the permit so the gate
  recovers immediately after a client-side abort.

## [0.2.1] - 2026-07-17

### Added

- **`thinking` stamp for `umans-glm*` models**: the thinking injection
  (`{ "type": "adaptive" }`) now applies to `umans-glm*` models alongside
  `umans-coder`, `umans-flash`, `umans-kimi*`, and `umans-qwen*`. GLM models
  still receive `max_tokens: 131071` and `output_config: { effort: "max" }`.
- **Dashboard capture-list queue counter**: the captures header now shows
  `active/total` (gate active count vs. capture count) instead of just the
  capture count, making queue depth visible at a glance.

### Fixed

- **Streaming permit lifecycle**: the concurrency permit was released in the
  `finally` block even when the response was streaming. Now the permit is
  released when the streaming response body cancels/aborts, and the `finally`
  block only releases it if streaming never started. Prevents premature permit
  release that could over-subscribe the concurrency gate during long streams.
- **Forwarded headers captured correctly**: the capture row now stores the
  forwarded (post-stamp) request headers — including `accept-encoding: identity`
  and `anthropic-beta`/`anthropic-version` when stamp beta is active — instead
  of the raw inbound headers. The inspector now shows exactly what was sent
  upstream.

### Changed

- **README restructure**: added "What It Does" feature table, "Important Notes"
  section (7 items covering request modification, vision strategy, hardcoded
  upstream, ring buffer, API key, foreground default, default concurrency),
  and "Usage Rights" clarification near the top. Moved the feature table from
  the install section to the intro.

## [0.2.0] - 2026-07-17

### Added

- **`saveConfigLocked()`**: async mutex-serialized wrapper around
  `saveConfig` that prevents read-modify-write races when concurrent
  callers (usage refresh, dashboard save) persist config at once. Now
  exported from the public API (`src/index.ts`) and used internally by
  the viewer and usage reconciler.
- **WriteQueue overflow `onDrop` callback**: when the queue overflows or
  is drained on shutdown, dropped captures are marked `failed` in the DB
  and a `state` WS message is broadcast — the dashboard reflects the
  real state instead of leaving entries in limbo.
- **WriteQueue exponential-backoff flush retry**: failed `batchUpdate`
  calls are retried with exponential backoff (1s → 30s, max 10 attempts)
  before the batch is dropped. Prevents transient SQLite errors
  (`SQLITE_BUSY`, disk-full) from permanently losing captures.
- **WriteQueue `drainForShutdown()`**: on graceful shutdown, the server
  flushes up to 3 times, then drains remaining entries via `onDrop` so
  no captures are silently lost when the process exits.
- **Vision inflight dedup**: the inflight cache entry is registered
  *before* the transcode await closes the TOCTOU window, so concurrent
  requests for the same image await one vision call instead of
  duplicating work.
- **Vision call timeout handling**: `AbortSignal.timeout` is now
  combined with the caller's signal, and `TimeoutError` is mapped to a
  new `"timeout"` status with a descriptive placeholder. Background
  vision uses an independent timeout signal so caller cancellation
  does not abort background processing.
- **Vision `gate_rejected` status**: a new vision call status and
  dashboard badge for requests rejected by the concurrency gate.
- **Image size guard in `transcodeImage`**: rejects inputs >25 MB
  before `Bun.Image` allocates a pixel buffer, bounding peak memory
  during parallel decode.
- **`fetchConcurrencyLimits` NaN guard**: malformed `/v1/usage`
  responses with non-finite concurrency values are now rejected with
  `malformed concurrency limits` instead of poisoning the gate.
- **`ConcurrencyGate` NaN fail-safe**: `setHardCap`/`setSoftLimit`
  clamp NaN or non-finite inputs to 1 with a warning, preventing the
  semaphore from entering a broken state.
- **15s timeout on `fetchUsageRaw`**: prevents the usage poller from
  hanging indefinitely on a stalled upstream.
- **`upstream_timeout_ms` hot-reloadable**: added to the reload field
  list so it applies without a restart.
- **`queue_max_depth`, `ws_backpressure_limit`,
  `ws_close_on_backpressure_limit`, `vision_pending_max_batch`** marked
  as restart-required fields (they cannot be hot-reloaded safely).
- **Connection warmer body drain**: the warmer now consumes/cancels
  the response body so the underlying TLS connection returns to the
  keep-alive pool instead of being discarded.
- **`resetConfig()` preserves `dashboard_token`** alongside
  `umans_api_key` so a reset does not lock the user out of the dashboard.
- **`PersistentDescriptionStore` flush retry**: failed flushes are
  retried up to 3 times before dropping the batch (logged), preventing
  an unbounded re-queue. TTL-expired cache reads no longer delete the
  row (avoids a write storm on repeated lookups).
- **Dashboard config-save response includes `applied` and
  `restartRequired`** arrays so the frontend can show exactly which
  fields were hot-reloaded vs require a restart.
- 24 new test files covering: circuit-breaker reconfigure, config
  reload orphan fields, config reset, config save mutex, persistent
  cache close/flush-cascade/read-no-delete, queue flush retry/overflow,
  shutdown data loss, usage boxed reason/fetch timeout/first-fetch
  failure/NaN poisoning/priority-low clear, vision cache-only stats,
  gate error, handoff background signal, inflight dedup, timeout,
  transcode memory, update failure, warmer traffic timing + warmer.

### Fixed

- **Config save race condition**: `applyLimitsFromSource` was calling
  synchronous `saveConfig` from an async context, causing interleaved
  read-modify-write cycles that could overwrite concurrent changes.
  Now uses `saveConfigLocked` with a module-level promise mutex.
- **Usage first-fetch failure permanently stamped gate to 1**: when
  the first `/v1/usage` fetch failed before any snapshot existed,
  `applyFailedSnapshot` fired `onChange` with the fail-safe snapshot
  (softLimit=1), permanently boxing the gate. Now the first-failure
  path skips `onChange` — `getSnapshot()` still returns the fail-safe
  for direct reads.
- **`boxedReason` rate-limit prefix matching**: the gate resize logic
  compared `boxedReason !== "rate_limited"` exactly, missing
  `"rate_limit_*"` variants. Now uses a case-insensitive prefix
  match so all rate-limit boxing variants bypass the `resize(1)` path.
- **Vision parallel processing memory spike**: `Promise.allSettled` on
  all kept images spawned parallel `Bun.Image` decodes, causing peak
  memory spikes. Switched to sequential processing — the concurrency
  gate serializes vision calls anyway.
- **Vision `updateVisionCapture` unhandled rejection**: a DB write
  failure during vision capture update was uncaught, crashing the
  process. Now wrapped in try/catch with the vision row marked
  `failed`.
- **`onTraffic` fired on gate-rejected requests**: the warmer
  `onTraffic` callback was called before `gate.acquire`, so
  rejected requests reset the warmer timer unnecessarily. Now fired
  only after successful acquire.
- **`enqueueBackgroundVision` ignored caller signal**: used
  `AbortSignal.any([signal])` (a no-op) instead of applying the
  configured timeout. Now uses an independent timeout signal.

## [0.1.9] - 2026-07-17

### Added

- **WebSocket `prune` message**: when the server's SQLite ring buffer evicts old
  captures, the server now broadcasts a `prune` message with the evicted IDs.
  The dashboard removes those IDs from its in-memory list so the frontend and
  backend stay in sync without a full refetch.
- **Frontend capture-list cap**: the dashboard caps its in-memory capture list
  at `MAX_CAPTURES` (200), matching the REST fetch limit. WS-driven growth no
  longer diverges from the server's ring buffer.
- **`ConcurrencyGate.resetHalfOpenProbe()`**: resets a half-open circuit-breaker
  probe back to `open` so a new probe can start after the previous probe times
  out or is aborted in the queue. Previously the probe slot was consumed and
  never reset, stalling recovery.
- **`ValidationContext`**: `validateConfig()` and `saveConfig()` accept an
  optional context carrying the upstream `/v1/usage` requests limit. Warning
  rules use it to suppress false-positive "rate limit unlimited" warnings when
  the upstream itself has no request cap.
- Tests for: half-open probe timeout reset, post-shutdown release safety,
  frontend list cap under WS flood, rate-limit warning suppression, and
  `max_captures` minimum boundary.
- Test helper now sets `XDG_CONFIG_HOME` to a temp dir so tests never read or
  write the developer's real `config.json`.

### Fixed

- **Proxy capture flush on client abort**: the `abort` listener is now
  registered before the `TransformStream` is created, so a mid-stream client
  disconnect flushes the capture even if the stream never produced a `flush`
  callback. The listener is removed on normal stream completion to prevent
  leaks.
- **`anthropic-beta` / `anthropic-version` header forcing**: these headers are
  now only sent when the stamp pipeline is enabled (`stampBeta`), not on every
  `/v1/messages` request. When stamping is off, the client-sent
  `anthropic-version` is preserved instead of being overwritten.
- **`ContextManagementStep` applies condition**: no longer requires
  `anthropic-version === "2023-06-01"`. The step now applies whenever the stamp
  bundle is enabled, regardless of the client-sent version header.
- **Post-shutdown permit release**: `Semaphore.releasePermit` is a no-op after
  `shutdown()`, preventing negative active counts and leaked cooldown timers
  from late releases.
- **`useUsage` endpoint path**: corrected from `/dashboard/api/usage` to
  `/usage` (the hook already prefixes `API_BASE`).

### Changed

- **`max_captures` minimum**: raised from 1 to 200 in both server validation
  and the dashboard config field, matching the default ring-buffer size.
- **`removeWaiter` return type**: now returns `boolean` (whether the waiter was
  found and removed) so callers can conditionally reset the breaker probe.
- **Dashboard config validation**: passes `upstreamRequestsLimit` from the
  usage snapshot into `validateConfigDraft` for cross-source warning logic.

## [0.1.8] - 2026-07-16

### Added

- **Dashboard token authentication** (SEC-NEW-1): when `DASHBOARD_TOKEN` is set,
  all `/dashboard/api/*` routes, `/health`, and `/metrics` require
  `Authorization: Bearer <token>`. WebSocket upgrades require `?token=<token>`.
  Includes constant-time token comparison and sliding-window auth-failure rate
  limiting to resist brute-force attacks. When unset, all endpoints remain open
  (backward compatible).
- **Standalone binary checksum verification** (SEC-03): binary updates are now
  verified against `SHA256SUMS` before replacement. Integration tests cover both
  the checksum-mismatch rejection path and the successful verification path.
- **PR canary npm publish workflow**: pull requests to `master` now automatically
  publish a canary npm package tagged `canary` (not `latest`) with version
  `{base}-pr.{number}.{short_sha}`. The published package matches the release
  structure: a main shim with optional platform-specific binary packages so it
  runs without Bun. A PR comment with the install command is posted and
  auto-updated on each push. Fork PRs are skipped for security.

### Fixed

- **Remove API key forwarding to upstream `/v1/models`** (SEC-01): the API key
  is no longer sent to the upstream `/v1/models` endpoint, preventing unintended
  credential exposure.
- **Vision handoff permit release** (BUG-01): the vision handoff permit is now
  released in a `finally` block, ensuring it is always returned to the
  concurrency gate even when processing rejects. The proxy permit lifecycle was
  refactored with a guarded release helper to prevent permit leaks on
  mid-stream aborts.
- **Capture body decompression failure** (BUG-02): hardened the decompression
  failure path with warnings that include the original byte length, and the
  dashboard now renders a null-safe placeholder for corrupted bodies instead of
  crashing.

### Changed

- **Config module decomposition**: the monolithic `config.ts` has been decomposed
  into focused sub-modules (`config/defaults.ts`, `config/loader.ts`,
  `config/reload.ts`, `config/types.ts`, `config/validation.ts`) with a barrel
  re-export from `config.ts` for backward compatibility.
- **CI workflow bumps**: `actions/checkout` bumped to v7 across all workflows.

### Performance

- **DB ring-buffer cleanup**: replaced `NOT IN` subquery with an indexed
  `OFFSET`-based cleanup query, keeping 10k-row cleanup under 50ms.
- **Vision cache parallelization**: `processBodyCacheOnly` now uses
  `Promise.allSettled` for parallel image-description cache lookups.
- **Vision transcoding optimization**: skip transcoding on cache-only hits and
  fail fast on cache miss to avoid unnecessary image processing.

## [0.1.7] - 2026-07-15

### Fixed

- **Vision reservation forced to 0 when `vision_strategy="never"`**: when vision
  interception is disabled, `concurrency_vision_reservation` is now normalized
  to 0 in both `validateConfig()` and `loadConfig()` so no concurrency slots are
  wasted on an unused intention. The field validation rule allows 0 in this case
  and the dashboard field description and minimum value are updated accordingly.
- **Always send `anthropic-beta` + `anthropic-version` headers on `/v1/messages`**:
  these headers are now sent on every `/v1/messages` request regardless of the
  `stampClaudeCode` setting. The `?beta=true` URL parameter remains gated by
  `stampClaudeCode`.

## [0.1.6] - 2026-07-14

### Added

- **Service mode display**: the upstream `/v1/usage` `service_mode` field
  is now parsed and surfaced in the dashboard as a badge in the gate
  status bar. Shows the current mode (e.g. `normal`, `interactive`,
  `degraded`) and optional `resets_at` timestamp in the tooltip. Falls
  back to `normal` when absent or on fetch failure.

## [0.1.5] - 2026-07-14

### Added

- **Service persistence** (`umans-gate service`): install, uninstall,
  start, stop, restart, status, and logs subcommands for running
  umans-gate as a managed service that starts on boot and survives
  restarts. Platform support:
  - **Linux**: systemd user unit with `enable-linger` for boot-start
    without login. `Restart=always` for crash recovery. `EnvironmentFile`
    with `chmod 600` for API key (never inline).
  - **macOS**: launchd LaunchAgent with `RunAtLoad=true` and
    `KeepAlive=true` for unconditional restart (including dashboard
    Restart button).
  - **Windows**: Windows Service via NSSM (bundled in win32 platform
    packages) with `SERVICE_AUTO_START` and 10 MB log rotation.
  - Service PATH includes common runtime directories (`~/.bun/bin`,
    `/opt/homebrew/bin`, `/usr/local/bin`, etc.) so the shebang resolves
    in minimal-PATH service environments.
  - Pre-install validation: config validation + port availability check
    before writing service files.
  - `npx` detection: `service install` from npx throws a clear error
    with install instructions.
  - `umans-gate update` now stops the service before updating and
    restarts it after.
  - `umans-gate uninstall` removes the service before cleaning up the
    binary.
  - Standalone binary self-update: `umans-gate update` auto-downloads
    and replaces the binary from the latest GitHub Release (previously
    only printed the URL).
  - Dashboard Restart button works automatically when running as a
    managed service.

### Fixed

- **launchd KeepAlive**: changed from conditional dict
  (`SuccessfulExit=false, Crashed=true`) to unconditional `true` so
  the dashboard Restart button works on macOS (previously only worked
  on Linux via `Restart=always`).
- **NSSM bundling**: `scripts/pack-npm.sh` now downloads and includes
  `nssm.exe` in `@codegiveness/umans-gate-win32-*` packages so
  `service install` works on Windows out of the box.
- **ESM compliance**: replaced `require("node:fs")` / `require("node:net")`
  calls in `installer.ts` and `updater.ts` with static imports.

## [0.1.4] - 2026-07-14

### Changed

- **npm package naming**: platform binary packages renamed from unscoped
  `umans-gate-<target>` to scoped `@codegiveness/umans-gate-<target>`
  (e.g. `@codegiveness/umans-gate-darwin-arm64`). This follows the
  industry convention used by `@esbuild/*`, `@rollup/rollup-*`, and
  `@swc/core-*` for platform-specific binary packages. The main package
  `umans-gate` is unchanged — `optionalDependencies` now reference the
  scoped packages.
- **npm-shim.cjs**: updated binary resolution paths to find
  `@codegiveness/umans-gate-<target>` in `node_modules/@codegiveness/`.
- **pack-npm.sh**: main package now includes README.md, LICENSE, and
  CHANGELOG.md in the published files so npm registry pages display
  the current README. Added keywords, homepage, and bugs fields to
  the generated package.json.
- **Release workflow**: publish step globs updated to
  `release/npm/@codegiveness/umans-gate-*/`.

### Fixed

- **Release workflow awk extraction**: the awk command extracting per-version
  release notes from CHANGELOG.md self-terminated on the matching header line,
  producing only `## [VERSION] - DATE` as release notes. Fixed with corrected
  awk logic that extracts the full version section body.
- **CodeQL workflow efficiency**: added `paths-ignore` for markdown, docs, and
  LICENSE files — CodeQL no longer runs on doc-only changes (matching CI
  workflow behavior).
- **CI workflow professionalization**: split monolithic CI into `quality` job
  (typecheck + lint + build, 3-OS matrix: ubuntu/macos/windows) and `test` job
  (ubuntu-only). Dropped Bun 1.1.0 from matrix (caused 158 test failures on
  ubuntu). Added dashboard asset build step before tests (`src/embedded-assets.ts`
  has static imports to gitignored `dashboard/dist/`). Replaced fragile
  `sleep(900)` in test helper with health-check polling (`GET /health`).
  Added `--timeout 30000` to test command (bunfig.toml `timeout` key is not
  respected by Bun).
- **Stuck master CI runs**: `cancel-in-progress` was only enabled for
  `pull_request` events — a stuck `in_progress` run held the concurrency
  group lock indefinitely, blocking all master push runs (stayed `pending`
  with 0 jobs). Fixed: `cancel-in-progress: true` for all events.
- **CI permissions hardening**: added `permissions: contents: read`
  (least-privilege) and `timeout-minutes: 15` to both CI jobs.
- **Dependabot hardening**: configured major-version bump ignores for
  critical dependencies (commander, lru-cache, @types/bun, react, react-dom,
  lucide-react, @types/react, @types/react-dom, vite, tailwind-merge, sonner,
  typescript, @vitejs/plugin-react, @base-ui/react). Closed 13 dangerous
  major-bump PRs.
- **Release workflow**: `--notes-file CHANGELOG.md` dumped the entire
  changelog as release notes — now extracts only the matching version
  section. Added `--frozen-lockfile` to all `bun install` steps. Added
  `timeout-minutes: 20` to prevent hung release builds.
- **Test helper singleton race condition**: `echo-upstream.ts` used a
  module-level singleton server that would break under parallel test
  execution. Refactored to per-instance servers with explicit lifecycle
  management.
- **CI dependency drift**: added `--frozen-lockfile` to all `bun install`
  steps in CI to fail fast on lockfile drift.
- **Stale draft releases**: deleted 5 stale draft releases from failed
  release workflow runs.

### Added

- **Branch protection** on master: requires 4 CI checks (Quality
  ubuntu/macos/windows + Tests), 1 code-owner review, linear history,
  stale review dismissal, no force pushes.
- **Repo settings professionalized**: squash-only merges, delete-branch-on-merge,
  wiki disabled, discussions disabled, secret scanning enabled, push protection
  enabled.
- **CODEOWNERS** (`.github/CODEOWNERS`) for automated review routing.
- **Dependabot update grouping**: minor and patch updates are now grouped into
  a single PR per ecosystem (root npm, dashboard npm) to reduce PR noise.

### Changed

- **ROADMAP**: updated Current State from v0.1.0 → v0.1.3 with npm distribution,
  self-update, platform binaries, and provenance as completed items. Added
  umans-open-stack cross-reference section.
- **CONTRIBUTING.md / GOVERNANCE.md**: fixed `main` → `master` branch references.
- **PRODUCT.md**: repositioned from "Bun-based" to "npm-installable (powered by Bun)"
  with npm-first success criteria.
- **TROUBLESHOOTING.md**: added npm-first user commands alongside dev commands.
- **bug_report.yml**: added install method field (npm/npx/standalone/source); Bun
  version now conditional on dev-from-source only.
- **ci.yml**: removed stale `main` from branch triggers (only `master` exists).
- **package.json keywords**: expanded from 10 → 18 keywords for npm discoverability
  (added `claude`, `prompt-engineering`, `observability`, `sqlite`, `bun`,
  `developer-tools`, `api-proxy`, `prompt-caching`).
- **ARCHITECTURE.md**: added umans-open-stack cross-reference with
  playbook-to-implementation mapping table.

### Security

- **SECURITY.md**: added account security section — 2FA requirement for npm
  publisher + GitHub org admins, token rotation policy, quarterly access review.

## [0.1.3] - 2026-07-14

### Fixed

- **npm package republish**: v0.1.2 was published via the now-deleted
  `publish.yml` workflow (raw `npm publish` on repo `package.json`), which
  shipped `dist/cli.js` with a `#!/usr/bin/env bun` shebang and `engines: { bun:
  ">=1.1.0" }` — **requiring Bun to run**. This contradicted the "no
  prerequisites" promise. v0.1.3 republishes via `release.yml` which runs
  `scripts/pack-npm.sh` to produce the correct shim-based package (`bin:
  npm-shim.cjs` + 6 platform `optionalDependencies` with pre-compiled
  standalone binaries). `npx umans-gate` now works without Bun installed.
- **ARCHITECTURE.md**: fixed wrong file paths in umans-open-stack mapping table
  (`src/gate.ts` → `src/limiter/gate.ts`, `src/vision.ts` → `src/vision/handoff.ts`).
- **README.md**: removed misleading `.env.example` reference (file only has
  `UMANS_API_KEY=`; reworded to reference config variables generally).
- **README.md**: fixed `vision_*` incorrectly listed as hot-reloadable — moved
  to `restartRequired` (matches `RESTART_REQUIRED_FIELDS` in `src/config.ts`).
- **SECURITY.md**: softened "SLSA Level 3 provenance" to "npm provenance
  attestation" for accuracy and consistency with ROADMAP.md.
- **docs/proxy-modifications.md**: fixed stale "24h TTL" → "7-day TTL" and
  "transcoded to JPEG" → "transcoded to the configured format (PNG/JPEG)".
- **AGENTS.md**: fixed stale config field names `target` (removed from config)
  and `stamp_cache_ttl` (replaced by `stamp_claude_code_enabled`).
- **CHANGELOG.md**: removed duplicate entries between [Unreleased] and [0.1.3].
- **MAINTAINERS.md**: populated template with actual maintainer (`@codegiveness`).
- **Startup banner** (`src/banner.ts`): version is now read from `package.json`
  instead of being hardcoded at `v0.1.0`. Every prior release printed the wrong
  version on startup.
- **`clean` script** (`package.json`): `capture.db` → `umans-gate.db` (3 file
  suffixes). `bun run clean` now correctly removes the actual database.
- **`biome.json`**: `capture.db*` → `umans-gate.db*` (stale entry from DB rename).
- **ARCHITECTURE.md**: fixed ASCII diagram alignment after `capture.db` →
  `umans-gate.db` rename (SQLite box widened to fit text, `┴` connector
  aligned with proxy box `┬` above).
- **Benchmark result files**: untracked 36 stale files across three benchmark
  directories (`benchmark/vision-handoff/results/`, `benchmark/proxy-optimizations/results/`,
  and `benchmark/concurrency-gate/results.json`) — they contained old
  `umans-ai/umans-gate` URLs in vision-test descriptions and a partially-redacted
  API key (`sk-f1qgI...tmJI`). Updated `.gitignore` to also match `results.json`
  files directly in benchmark directories (not just `results/` subdirectories).
- **README badge**: removed misleading "Runtime: Bun" badge (contradicts "No
  prerequisites for npm/npx"). Added CodeQL badge.
- **CI lint failures**: added `src/embedded-assets.ts` to `biome.json` ignore
  list (generated file with long import lines that Biome wanted to reformat).
  Auto-fixed `package.json` `files` array formatting (Biome wanted inline).
  These two pre-existing lint errors caused ALL CI runs and ALL Dependabot PRs
  to fail.
- **Release workflow resilience**: `release.yml` now retries each npm publish
  step 3 times with 15s delays. Platform package publish failures no longer
  block the main shim from publishing (previously `win32-arm64` spam detection
  failure prevented the entire release).

### Added

- **CodeQL code scanning** (`.github/workflows/codeql.yml`) — weekly automated
  security analysis for JavaScript/TypeScript.

## [0.1.2] - 2026-07-14

### Fixed

- Add `repository.url` and `license` to platform-specific npm packages generated
  by `scripts/pack-npm.sh` to fix npm provenance publishing (E422 rejection).

## [0.1.1] - 2026-07-14

### Fixed

- Fix `repository.url` in `package.json` to point to `codegiveness/umans-gate`
  (was `umans-ai/umans-gate` — npm page linked to wrong repo).

## [0.1.0] - 2026-07-10

### Added

- **Vision handoff pipeline**: replaces image blocks with text descriptions
  generated by a separate vision model (`umans-flash`). Images are transcoded
  to JPEG/PNG, sent to the vision model, and descriptions are cached (7-day TTL)
  with persistent storage. Strategies: `always`, `catalog`, `never`.
  - Modules: `src/vision/` (`handoff.ts`, `detect.ts`, `cache.ts`,
    `persistent-cache.ts`, `transcode.ts`, `wrapper.ts`, `sink.ts`)
  - `src/vision-description-store.ts` — persistent description storage in SQLite
- **Concurrency gate** (`src/limiter/`): semaphore + circuit breaker with
  intention-based reservations (main vs vision), hard cap, soft limit driven by
  `/v1/usage`, queue timeout, and over-subscription fallback.
  - `src/limiter/gate.ts` — `ConcurrencyGate`, `Semaphore`, `CircuitBreaker`
  - `src/limiter/types.ts` — gate option types
- **Rate limiting** (`src/rate.ts`): sliding-window weighted rate limiter for
  pro-tier request limits. Auto-derives from `/v1/usage` or explicit config.
- **Connection warmer** (`src/warmer.ts`): periodic `/v1/models` pings to keep
  TLS warm. Skips when real traffic occurred in the last interval.
- **Usage tracking** (`src/usage.ts`, `src/usage-extract.ts`): fetches and
  reconciles `/v1/usage` data to size concurrency limits, detect rate-boxing,
  and demote priority. Extractors for Anthropic + OpenAI streaming/non-streaming.
- **Economics module** (`src/economics.ts`): token cost calculation per capture.
- **Metrics module** (`src/metrics.ts`): aggregated runtime statistics.
- **Model info parser** (`src/model-info-parser.ts`): parses `/v1/models`
  response to determine vision support per model.
- **Model policy** (`src/model-policy.ts`): model-aware stamping decisions.
- **Compressed capture storage** (`src/compress.ts`): zstd compression for
  request/response bodies (default: on).
- **Worker-based capture pipeline** (`src/workers/`): offload capture writes to
  a worker thread for non-blocking streaming.
- **Stamp pipeline** (`src/stamp-pipeline.ts`): unified stamping orchestrator
  that applies TTL, `top_k`, `max_tokens`, `thinking`, `output_config`,
  `context_management`, and `temperature` stamps in the correct order.
- **Individual stamp modules**:
  - `src/stamp-temperature.ts` — forces `temperature` value
  - `src/stamp-thinking.ts` — injects `thinking`, `max_tokens`, `output_config`
  - `src/stamp-topk.ts` — injects `top_k`
  - `src/stamp-reasoning.ts` — OpenAI-compatible `reasoning_effort` stamping
- **Bundled stamp toggle**: `stamp_claude_code_enabled` replaces individual
  stamp toggles — one switch applies the full Claude Code stamp bundle.
- **Dashboard config validation**: dispatch-table-based validation with
  hot-reload support and restart-required field detection.
- **Dashboard polling consolidation**: `usePollingResource` hook unifies
  triplicated polling logic.
- **WebSocket backpressure management**: configurable limit and auto-close.
- **Upstream timeout** (`upstream_timeout_ms`): configurable fetch timeout.
- **Capture body size limit** (`capture_body_max_bytes`).
- **Logger** (`src/logger.ts`): structured scoped logging replacing `console.*`.
- **Shared utilities** (`src/shared/`): extracted domain helpers for
  model-name parsing, usage fetching, dashboard constants, and vision sink.

### Changed

- **SOLID refactor (Waves 1–5)**: split monolithic modules into focused,
  single-responsibility units. Helpers split into domain modules, `ConcurrencyGate`
  decomposed into `Semaphore` + `CircuitBreaker`, `useCaptures` split into
  `useCaptureList` + `useCaptureDetail` + `useGateStats`, config validation
  replaced if/else chains with dispatch tables.
- **Stamp toggles consolidated**: individual `stamp_cache_ttl_enabled`,
  `stamp_top_k_enabled`, `stamp_max_tokens_enabled`, `stamp_thinking_enabled`,
  `stamp_output_config_enabled` → single `stamp_claude_code_enabled`.
- **Vision strategy default**: `always` → `catalog` (only intercept when model
  lacks vision support).
- **Vision image format default**: `jpeg` → `png` (higher fidelity for OCR).
- **Vision cache TTL default**: 24h → 7 days (`604800000ms`).
- **`max_tokens` stamp values**: GLM models get `131071`, non-GLM get `32767`.
- **Config validation**: now uses dispatch table instead of if/else chains.
- **Dashboard capture detail**: copy-status derived from source state.
- **Usage extraction**: replaced provider×streaming dispatch with `EXTRACTORS`
  lookup table.
- **ConnectionWarmer**: narrowed constructor to `Pick<ProxyConfig, ...>`.

### Fixed

- Streaming `duration_ms` now floors at wall-clock to prevent timing collapse
- Limiter allows permit acquisition when reservations are over-subscribed
- `stamp-reasoning` correctly removes `max_tokens`/`thinking` before injection

## [0.0.1] - 2025-07-02

### Added

- TypeScript rewrite of the capture proxy (modular `src/` structure)
- Vite + React + Tailwind + shadcn/ui dashboard
- `createProxyServer()` programmatic API
- Biome for linting and formatting
- GitHub Actions CI (matrix: ubuntu + macOS, Bun 1.1 + latest)
- npm publish workflow with Sigstore provenance
- Issue templates, PR template, dependabot config
- `.env.example` documenting all environment variables
- MIT license

### Changed

- Single-file `capture.js` → modular TypeScript in `src/`
- Vanilla JS dashboard → React + shadcn/ui dashboard
- Test helpers reference new entry point (no more `proxy.js`/`capture-only.js`)

### Fixed

- Broken tests that spawned non-existent `proxy.js` file
- Runtime artifacts (`capture.db*`) now gitignored
