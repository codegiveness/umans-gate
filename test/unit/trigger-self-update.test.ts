// Regression test for dashboard update button bug.
// The old /api/update handler called stopService() inline, which killed the
// proxy process (in the service cgroup) before performUpdate() could run.
// The fix: triggerSelfUpdate() spawns a detached CLI process that escapes
// the service cgroup.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

const FAKE_BIN = "/tmp/umans-gate-trigger-test-bin";

interface SpawnCall {
  cmd: string;
  args: string[];
  options: { detached?: boolean; stdio?: unknown; shell?: boolean };
  unrefCalled: boolean;
}

let spawnCalls: SpawnCall[] = [];
let spawnSyncResult: { status: number; stdout: string } = { status: 0, stdout: "" };
let mockedPlatformId: string = "systemd";

mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: (cmd: string, args: string[], options: unknown) => {
    const call: SpawnCall = {
      cmd,
      args,
      options: (options ?? {}) as SpawnCall["options"],
      unrefCalled: false,
    };
    spawnCalls.push(call);
    return {
      unref: () => {
        call.unrefCalled = true;
      },
    };
  },
  spawnSync: () => spawnSyncResult,
}));

mock.module("../../src/service/detect.js", () => ({
  detectPlatform: () => mockedPlatformId,
  platformName: () => "mocked",
}));

const { triggerSelfUpdate } = await import("../../src/updater.js");

beforeEach(() => {
  spawnCalls = [];
  spawnSyncResult = { status: 0, stdout: "" };
  mockedPlatformId = "systemd";
  writeFileSync(FAKE_BIN, "#!/bin/sh\nexit 0\n");
});

afterEach(() => {
  try {
    unlinkSync(FAKE_BIN);
  } catch {
    // ignore
  }
});

describe("triggerSelfUpdate", () => {
  test("spawns a detached systemd-run process on systemd", () => {
    mockedPlatformId = "systemd";
    process.execPath = FAKE_BIN;

    const result = triggerSelfUpdate();

    expect(result).toBe(true);
    expect(spawnCalls.length).toBe(1);

    const call = spawnCalls[0];
    expect(call.cmd).toBe("systemd-run");
    expect(call.args).toContain("update");
    expect(call.options.detached).toBe(true);
    expect(call.unrefCalled).toBe(true);
  });

  test("spawns detached binary directly on launchd", () => {
    mockedPlatformId = "launchd";
    process.execPath = FAKE_BIN;

    const result = triggerSelfUpdate();

    expect(result).toBe(true);
    expect(spawnCalls.length).toBe(1);

    const call = spawnCalls[0];
    expect(call.cmd).toBe(FAKE_BIN);
    expect(call.args).toEqual(["update"]);
    expect(call.options.detached).toBe(true);
    expect(call.unrefCalled).toBe(true);
  });

  test("spawns detached with shell on unsupported platform", () => {
    mockedPlatformId = "unsupported";
    process.execPath = FAKE_BIN;

    const result = triggerSelfUpdate();

    expect(result).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].options.shell).toBe(true);
  });

  test("returns false when binary cannot be resolved", () => {
    mockedPlatformId = "systemd";
    process.execPath = "/usr/local/bin/node";
    spawnSyncResult = { status: 1, stdout: "" };

    const result = triggerSelfUpdate();

    expect(result).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });

  test("does NOT spawn systemctl stop (the bug)", () => {
    mockedPlatformId = "systemd";
    process.execPath = FAKE_BIN;

    triggerSelfUpdate();

    // The fix: the only spawn call is the detached CLI update command.
    // The old bug called stopService() which runs `systemctl stop` —
    // that would kill THIS process. Verify no such command was spawned.
    for (const call of spawnCalls) {
      const allArgs = [call.cmd, ...call.args].join(" ");
      expect(allArgs).not.toContain("stop");
    }
  });
});
