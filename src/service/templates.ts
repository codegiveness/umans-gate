// Service file template generators.
// Pure functions: input → string output. No I/O, no side effects (SRP).

import type { InstallOptions } from "./types.js";

/**
 * Render a systemd user unit file.
 *
 * ExecStart points to the binary path (npm symlink or standalone binary).
 * Restart=always provides crash recovery.
 * If apiKey is provided and not already in config.json, an EnvironmentFile
 * with chmod 600 is used instead of inline Environment to avoid leaking
 * the key via `systemctl --user show`.
 */
export function renderSystemdUnit(opts: InstallOptions): string {
  const lines: string[] = [
    "[Unit]",
    "Description=umans-gate LLM capture proxy",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${opts.binaryPath}`,
    "Restart=always",
    "RestartSec=3",
    `WorkingDirectory=${opts.workingDir}`,
  ];

  if (opts.servicePath) {
    lines.push(`Environment="PATH=${opts.servicePath}"`);
  }

  if (opts.apiKey) {
    const envFilePath = `${opts.workingDir}/.config/umans-gate/service.env`;
    lines.push(`EnvironmentFile=${envFilePath}`);
  }

  lines.push("", "[Install]", "WantedBy=default.target");

  return `${lines.join("\n")}\n`;
}

/**
 * Render the env file content for systemd EnvironmentFile.
 * Contains UMANS_API_KEY if the key is only available via env.
 */
export function renderEnvFile(apiKey: string): string {
  return `UMANS_API_KEY=${apiKey}\n`;
}

/**
 * Render a launchd LaunchAgent plist for macOS.
 *
 * RunAtLoad starts the service on login.
 * KeepAlive=true provides unconditional restart (including clean exit from
 * the dashboard Restart button), matching systemd's Restart=always.
 */
export function renderLaunchdPlist(opts: InstallOptions): string {
  const envVars: string[] = [];
  if (opts.servicePath) {
    envVars.push(
      "    <key>EnvironmentVariables</key>",
      "    <dict>",
      "      <key>PATH</key>",
      `      <string>${escapeXml(opts.servicePath)}</string>`,
    );
  }

  if (opts.apiKey) {
    if (envVars.length === 0) {
      envVars.push("    <key>EnvironmentVariables</key>", "    <dict>");
    }
    envVars.push(
      "      <key>UMANS_API_KEY</key>",
      `      <string>${escapeXml(opts.apiKey)}</string>`,
    );
  }

  if (envVars.length > 0) {
    envVars.push("    </dict>");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.umans.gate</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.binaryPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDir)}</string>
${envVars.join("\n")}
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logDir)}/umans-gate.log</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logDir)}/umans-gate.err.log</string>
</dict>
</plist>
`;
}

/**
 * Render the NSSM command sequence for Windows Service installation.
 * Returns an array of [command, ...args] tuples for the installer to execute.
 */
export function nssmCommands(
  serviceName: string,
  opts: InstallOptions,
): Array<[string, ...string[]]> {
  const logPath = opts.logDir.replace(/\//g, "\\");
  const binaryPath = opts.binaryPath.replace(/\//g, "\\");
  const workingDir = opts.workingDir.replace(/\//g, "\\");

  const commands: Array<[string, ...string[]]> = [
    ["nssm", "install", serviceName, binaryPath],
    ["nssm", "set", serviceName, "AppDirectory", workingDir],
    ["nssm", "set", serviceName, "Start", "SERVICE_AUTO_START"],
    ["nssm", "set", serviceName, "AppStdout", `${logPath}\\umans-gate.log`],
    ["nssm", "set", serviceName, "AppStderr", `${logPath}\\umans-gate.err.log`],
    ["nssm", "set", serviceName, "AppRotateFiles", "1"],
    ["nssm", "set", serviceName, "AppRotateBytes", "10485760"],
  ];

  const extraEnvParts: string[] = [];
  if (opts.servicePath) {
    const winPath = opts.servicePath.replace(/\//g, "\\");
    extraEnvParts.push(`PATH=${winPath}`);
  }
  if (opts.apiKey) {
    extraEnvParts.push(`UMANS_API_KEY=${opts.apiKey}`);
  }
  if (extraEnvParts.length > 0) {
    commands.push(["nssm", "set", serviceName, "AppEnvironmentExtra", ...extraEnvParts]);
  }

  return commands;
}

/** Escape a string for safe inclusion in an XML plist. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
