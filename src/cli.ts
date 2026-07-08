#!/usr/bin/env bun
// CLI entry point for umans-gate.
// Usage: bun src/cli.ts  (or after build: umans-gate)
// Point your harness base URL → http://localhost:9000
// Open the inspector → http://localhost:9000/dashboard/

import { createProxyServer } from "./index.js";

createProxyServer();
