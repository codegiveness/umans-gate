import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("S5 env-example: .env.example documents UMANS_API_KEY", () => {
  const content = readFileSync(".env.example", "utf-8");
  expect(content).toMatch(/^UMANS_API_KEY=/m);
});
