// Startup banner — prints the proxy configuration to stderr.

import type { ProxyConfig } from "./types.js";

/** Print the startup banner showing all resolved config values. */
export function printBanner(config: ProxyConfig): void {
  const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const cacheDesc = config.stampTtl
    ? `on (anthropic: ttl="${config.stampTtl}")`
    : "off (transparent passthrough)";
  const topKDesc = config.stampTopK !== null ? `on (top_k=${config.stampTopK})` : "off";

  // Use console.log for the banner — it's informational, not an error.
  // The original used console.log for all banner lines.
  console.log("╭─ LLM capture proxy");
  console.log(`├─ listen : ${config.host}:${config.port}`);
  console.log(`├─ target : ${config.target}`);
  console.log(`├─ cache  : ${cacheDesc}`);
  console.log(`├─ top_k  : ${topKDesc}`);
  if (config.visionStrategy !== "never") {
    console.log(
      `├─ vision : ${config.visionStrategy} (model=${config.visionModel}, concurrency=${config.visionConcurrency})`,
    );
  }
  console.log(`├─ proto  : in ${config.incomingProtocol} → out ${config.upstreamProtocol}`);
  if (config.warmerEnabled) {
    console.log(`├─ warm   : every ${config.warmerIntervalMs}ms → ${config.warmerPath}`);
  }
  console.log(`├─ proxy  : http://${displayHost}:${config.port}/   (point harness base URL here)`);
  console.log(`├─ viewer : http://${displayHost}:${config.port}${config.viewerPrefix}/`);
  console.log(`╰─ store  : ${config.dbPath} (keeps last ${config.maxCaptures})`);
}
