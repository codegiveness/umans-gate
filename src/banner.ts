// Startup banner — prints the proxy configuration to stderr.

import pkg from "../package.json" with { type: "json" };
import type { ProxyConfig } from "./types.js";

/** Print the startup banner showing all resolved config values. */
export function printBanner(config: ProxyConfig): void {
  const displayHost = "localhost";
  const cacheDesc = config.stampClaudeCode
    ? "on (claude code: ttl, top_k, max_tokens, thinking, output_config, context_management)"
    : "off (transparent passthrough)";

  console.log(`umans-gate v${pkg.version} — LLM capture proxy`);
  console.log();
  console.log(`  target    ${config.target}`);
  console.log(`  listen    ${config.host}:${config.port}`);
  console.log(`  proto     in ${config.incomingProtocol} → out ${config.upstreamProtocol}`);
  console.log(`  cache     ${cacheDesc}`);
  if (config.visionStrategy !== "never") {
    console.log(
      `  vision    ${config.visionStrategy} (model=${config.visionModel}, concurrency=${config.visionConcurrency})`,
    );
  }
  if (config.warmerEnabled) {
    console.log(`  warm      every ${config.warmerIntervalMs}ms → ${config.warmerPath}`);
  }
  console.log(`  proxy     http://${displayHost}:${config.port}/`);
  console.log(`  dashboard http://${displayHost}:${config.port}${config.viewerPrefix}/`);
  console.log(`  store     ${config.dbPath} (keeps last ${config.maxCaptures})`);
  console.log();
}
