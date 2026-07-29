// Staleness guard for dashboard build artifacts.
//
// The CLI imports `src/embedded-assets.ts`, which references hashed files
// under `dashboard/dist/`. If the dashboard source changes but isn't
// rebuilt, the proxy crashes with a cryptic "Cannot find module" error.
// This guard surfaces a clear, actionable message instead.

import { existsSync, statSync } from "node:fs";

export function assertDashboardAssetsFresh(): void {
  const dashboardDist = `${process.cwd()}/dashboard/dist`;
  const embeddedAssets = `${process.cwd()}/src/embedded-assets.ts`;
  if (!existsSync(`${dashboardDist}/index.html`) || !existsSync(embeddedAssets)) {
    throw new Error(
      "Dashboard assets missing. Run `bun run build` before running tests. " +
        "(Generates dashboard/dist/ + src/embedded-assets.ts)",
    );
  }
  const distMtime = statSync(`${dashboardDist}/index.html`).mtimeMs;
  const srcMtime = statSync(embeddedAssets).mtimeMs;
  if (srcMtime < distMtime - 1000) {
    throw new Error(
      "src/embedded-assets.ts is older than dashboard/dist/ — assets are stale. " +
        "Run `bun run build` to regenerate.",
    );
  }
}
