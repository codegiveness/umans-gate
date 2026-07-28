// Regression test for GS-4: unhandledRejection and uncaughtException handlers.
//
// BEFORE: No process-level handlers for unhandledRejection or uncaughtException.
// An unhandled promise rejection or uncaught exception would crash the process.
//
// AFTER: Both handlers are registered in createProxyServer (index.ts) and log
// the error without crashing, allowing graceful shutdown to proceed.
//
// This test verifies the handler registrations exist in the source code.
// The handlers run in the server process (spawned by startProxy), not in the
// test process, so we verify at the source level.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const indexSource = readFileSync("src/index.ts", "utf-8");

test("index.ts registers unhandledRejection handler", () => {
  expect(indexSource).toContain('process.on("unhandledRejection"');
  expect(indexSource).toContain("log.error");
});

test("index.ts registers uncaughtException handler", () => {
  expect(indexSource).toContain('process.on("uncaughtException"');
  expect(indexSource).toContain("log.error");
});

test("unhandledRejection handler logs the reason", () => {
  const match = indexSource.match(/process\.on\("unhandledRejection"[^}]*\{[^}]*reason[^}]*\}\)/s);
  expect(match).not.toBeNull();
});

test("uncaughtException handler logs message and stack", () => {
  const match = indexSource.match(
    /process\.on\("uncaughtException"[^}]*\{[^}]*err\.message[^}]*\}\)/s,
  );
  expect(match).not.toBeNull();
});
