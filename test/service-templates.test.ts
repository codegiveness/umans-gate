// Tests for the service module: templates, detect, status formatting.
// These are pure unit tests — no actual systemctl/launchctl/nssm calls.

import { expect, test } from "bun:test";
import { detectPlatform, platformName } from "../src/service/detect.js";
import { formatStatus, formatUptime, resolveLogDir } from "../src/service/status.js";
import {
  nssmCommands,
  renderEnvFile,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "../src/service/templates.js";
import type { InstallOptions, ServiceStatus } from "../src/service/types.js";

// --- Template tests ---

const baseOpts: InstallOptions = {
  binaryPath: "/usr/local/bin/umans-gate",
  workingDir: "/home/user",
  logDir: "/home/user/.config/umans-gate/logs",
  force: false,
  servicePath: "/usr/local/bin:/usr/bin:/bin",
};

test("renderSystemdUnit produces valid systemd unit", () => {
  const unit = renderSystemdUnit(baseOpts);
  expect(unit).toContain("[Unit]");
  expect(unit).toContain("Description=umans-gate LLM capture proxy");
  expect(unit).toContain("After=network-online.target");
  expect(unit).toContain("Type=simple");
  expect(unit).toContain("ExecStart=/usr/local/bin/umans-gate");
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("RestartSec=3");
  expect(unit).toContain("WorkingDirectory=/home/user");
  expect(unit).toContain("[Install]");
  expect(unit).toContain("WantedBy=default.target");
});

test("renderSystemdUnit includes EnvironmentFile when apiKey is set", () => {
  const opts: InstallOptions = { ...baseOpts, apiKey: "sk-test-123" };
  const unit = renderSystemdUnit(opts);
  expect(unit).toContain("EnvironmentFile=");
  // Should NOT include inline Environment with the key
  expect(unit).not.toContain("UMANS_API_KEY=sk-test-123");
});

test("renderSystemdUnit does not include EnvironmentFile when no apiKey", () => {
  const unit = renderSystemdUnit(baseOpts);
  expect(unit).not.toContain("EnvironmentFile=");
});

test("renderSystemdUnit includes PATH environment when servicePath is set", () => {
  const unit = renderSystemdUnit(baseOpts);
  expect(unit).toContain('Environment="PATH=');
  expect(unit).toContain("/usr/local/bin:/usr/bin:/bin");
});

test("renderSystemdUnit omits PATH when servicePath is not set", () => {
  const opts: InstallOptions = { ...baseOpts, servicePath: undefined };
  const unit = renderSystemdUnit(opts);
  expect(unit).not.toContain('Environment="PATH=');
});

test("renderEnvFile produces correct format", () => {
  const content = renderEnvFile("sk-test-key");
  expect(content).toContain("UMANS_API_KEY=sk-test-key");
  expect(content.endsWith("\n")).toBe(true);
});

test("renderLaunchdPlist produces valid XML plist", () => {
  const plist = renderLaunchdPlist(baseOpts);
  expect(plist).toContain('<?xml version="1.0"');
  expect(plist).toContain('<plist version="1.0">');
  expect(plist).toContain("<key>Label</key>");
  expect(plist).toContain("<string>com.umans.gate</string>");
  expect(plist).toContain("<key>ProgramArguments</key>");
  expect(plist).toContain("/usr/local/bin/umans-gate");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<true/>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<key>WorkingDirectory</key>");
  expect(plist).toContain("<key>StandardOutPath</key>");
  expect(plist).toContain("<key>StandardErrorPath</key>");
});

test("renderLaunchdPlist uses unconditional KeepAlive=true", () => {
  const plist = renderLaunchdPlist(baseOpts);
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<true/>");
  expect(plist).not.toContain("SuccessfulExit");
  expect(plist).not.toContain("Crashed");
});

test("renderLaunchdPlist includes API key env when provided", () => {
  const opts: InstallOptions = { ...baseOpts, apiKey: "sk-test-123" };
  const plist = renderLaunchdPlist(opts);
  expect(plist).toContain("<key>EnvironmentVariables</key>");
  expect(plist).toContain("UMANS_API_KEY");
  expect(plist).toContain("sk-test-123");
});

test("renderLaunchdPlist includes PATH env when servicePath is set", () => {
  const plist = renderLaunchdPlist(baseOpts);
  expect(plist).toContain("<key>PATH</key>");
  expect(plist).toContain("/usr/local/bin:/usr/bin:/bin");
});

test("renderLaunchdPlist escapes XML special characters in paths", () => {
  const opts: InstallOptions = {
    ...baseOpts,
    binaryPath: "/path/with<>&\"'special/umans-gate",
  };
  const plist = renderLaunchdPlist(opts);
  expect(plist).toContain("&lt;");
  expect(plist).toContain("&gt;");
  expect(plist).toContain("&amp;");
  expect(plist).toContain("&quot;");
  expect(plist).toContain("&apos;");
  expect(plist).not.toContain("/path/with<>&\"'special");
});

test("nssmCommands returns correct sequence for basic install", () => {
  const commands = nssmCommands("umans-gate", baseOpts);
  expect(commands.length).toBe(8);

  // First command should be nssm install
  expect(commands[0][0]).toBe("nssm");
  expect(commands[0][1]).toBe("install");
  expect(commands[0][2]).toBe("umans-gate");

  // Should set AppDirectory
  const appDirCmd = commands.find((c) => c[3] === "AppDirectory");
  expect(appDirCmd).toBeDefined();

  // Should set Start to SERVICE_AUTO_START
  const startCmd = commands.find((c) => c[3] === "Start");
  expect(startCmd).toBeDefined();
  expect(startCmd?.[4]).toBe("SERVICE_AUTO_START");

  // Should set log paths
  const stdoutCmd = commands.find((c) => c[3] === "AppStdout");
  expect(stdoutCmd).toBeDefined();
  expect(stdoutCmd?.[4]).toContain("umans-gate.log");

  // Should set rotation
  const rotateCmd = commands.find((c) => c[3] === "AppRotateFiles");
  expect(rotateCmd).toBeDefined();
  expect(rotateCmd?.[4]).toBe("1");
});

test("nssmCommands includes AppEnvironmentExtra when apiKey is set", () => {
  const opts: InstallOptions = {
    ...baseOpts,
    apiKey: "sk-test-123",
    servicePath: "C:\\Users\\test\\.bun\\bin;C:\\Program Files\\nodejs",
  };
  const commands = nssmCommands("umans-gate", opts);
  expect(commands.length).toBe(8);

  const envCmd = commands.find((c) => c[3] === "AppEnvironmentExtra");
  expect(envCmd).toBeDefined();
  const envArgs = envCmd?.slice(4) as string[];
  expect(envArgs).toContain("UMANS_API_KEY=sk-test-123");
  expect(envArgs.some((a) => a.startsWith("PATH="))).toBe(true);
});

test("nssmCommands includes only PATH in AppEnvironmentExtra when no apiKey", () => {
  const opts: InstallOptions = {
    ...baseOpts,
    servicePath: "C:\\Users\\test\\.bun\\bin;C:\\Program Files\\nodejs",
  };
  const commands = nssmCommands("umans-gate", opts);
  expect(commands.length).toBe(8);

  const envCmd = commands.find((c) => c[3] === "AppEnvironmentExtra");
  expect(envCmd).toBeDefined();
  expect(envCmd?.[4]).toBe("PATH=C:\\Users\\test\\.bun\\bin;C:\\Program Files\\nodejs");
  expect(envCmd?.[5]).toBeUndefined();
});

test("nssmCommands converts forward slashes to backslashes for Windows paths", () => {
  const opts: InstallOptions = {
    ...baseOpts,
    binaryPath: "C:/Users/test/umans-gate",
    workingDir: "C:/Users/test",
    logDir: "C:/Users/test/logs",
  };
  const commands = nssmCommands("umans-gate", opts);
  const installCmd = commands[0];
  expect(installCmd[3]).toBe("C:\\Users\\test\\umans-gate");

  const appDirCmd = commands.find((c) => c[3] === "AppDirectory");
  expect(appDirCmd?.[4]).toBe("C:\\Users\\test");
});

// --- Detect tests ---

test("detectPlatform returns a valid PlatformId", () => {
  const p = detectPlatform();
  expect(["systemd", "launchd", "windows-service", "unsupported"]).toContain(p);
});

test("platformName returns a non-empty string", () => {
  const name = platformName();
  expect(name.length).toBeGreaterThan(0);
});

// --- Status formatting tests ---

test("formatUptime formats milliseconds to human readable", () => {
  expect(formatUptime(5000)).toBe("5s");
  expect(formatUptime(65000)).toBe("1m 5s");
  expect(formatUptime(3661000)).toBe("1h 1m");
  expect(formatUptime(90061000)).toBe("1d 1h 1m");
});

test("formatStatus shows not installed when not installed", () => {
  const status: ServiceStatus = {
    installed: false,
    running: false,
    statusLine: "not installed",
  };
  const result = formatStatus(status);
  expect(result).toContain("not installed");
});

test("formatStatus shows running state", () => {
  const status: ServiceStatus = {
    installed: true,
    running: true,
    pid: 12345,
    uptimeMs: 90061000,
    statusLine: "active (running)",
  };
  const result = formatStatus(status);
  expect(result).toContain("installed");
  expect(result).toContain("running");
  expect(result).toContain("PID: 12345");
  expect(result).toContain("Uptime: 1d 1h 1m");
});

test("formatStatus shows stopped state with exit code", () => {
  const status: ServiceStatus = {
    installed: true,
    running: false,
    lastExitCode: 1,
    statusLine: "failed (exit-code)",
  };
  const result = formatStatus(status);
  expect(result).toContain("not running");
  expect(result).toContain("Last exit code: 1");
});

test("resolveLogDir returns a path containing umans-gate", () => {
  const dir = resolveLogDir();
  expect(dir).toContain("umans-gate");
  expect(dir).toContain("logs");
});
