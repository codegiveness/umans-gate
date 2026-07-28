// Regression test: WS connection effect must not depend on selection state or
// callback identities. Either one would cause reconnects on every render/selection
// (flicker, lost messages). The hook keeps callbacks in refs and selection state
// outside the socket hook, so the effect only re-runs when backend reachability
// or the state setter changes.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "dashboard",
  "src",
  "hooks",
  "use-captures-socket.ts",
);

test("useCapturesSocket WS useEffect does not depend on selectedId or callbacks", () => {
  const source = readFileSync(HOOK_PATH, "utf-8");

  // Find the useEffect that contains "new WebSocket" — that's the WS connection effect.
  // Then extract its dependency array.
  const wsEffectMatch = source.match(
    /useEffect\(\(\) => \{[\s\S]*?new WebSocket[\s\S]*?\}, \[([^\]]+)\]/,
  );
  expect(wsEffectMatch).not.toBeNull();

  const deps = wsEffectMatch![1];
  const depList = deps.split(",").map((d) => d.trim());

  // selectedId must NOT be in the deps — it would cause reconnect on every selection.
  expect(depList).not.toContain("selectedId");

  // Callback identities must NOT be in the deps — they change on every render.
  for (const callback of [
    "onConnected",
    "onCaptureClear",
    "onCaptureState",
    "onGateStats",
    "onCaptureUpsert",
  ]) {
    expect(depList).not.toContain(callback);
  }

  // Callbacks are stored in refs so the effect always invokes the latest version.
  expect(source).toMatch(
    /onConnectedRef|onCaptureClearRef|onCaptureStateRef|onGateStatsRef|onCaptureUpsertRef/,
  );
});
