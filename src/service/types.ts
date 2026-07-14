// Shared types for the service management module.
// Each platform manager (systemd, launchd, windows-service) implements
// the ServiceManager interface — the dispatcher depends on the abstraction,
// not the concrete implementation (DIP/ISP).

/** Options passed to install(). */
export interface InstallOptions {
  /** Absolute path to the umans-gate executable or npm shim symlink. */
  binaryPath: string;
  /** Working directory for the service process. */
  workingDir: string;
  /** API key if only available via env (not in config.json). Written to env file with chmod 600. */
  apiKey?: string;
  /** Directory for service log files. */
  logDir: string;
  /** Overwrite an existing service configuration. */
  force?: boolean;
  /** PATH environment for the service (systemd/launchd have minimal PATH by default). */
  servicePath?: string;
}

/** Result of install(). */
export interface InstallResult {
  /** Path to the service file that was written (unit, plist, or empty for Windows registry). */
  serviceFilePath: string;
  /** Human-readable summary of what was done. */
  message: string;
}

/** Result of uninstall(). */
export interface UninstallResult {
  /** Human-readable summary. */
  message: string;
}

/** Service status snapshot. */
export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  uptimeMs?: number;
  lastExitCode?: number;
  /** Human-readable status line (e.g. "active (running)"). */
  statusLine: string;
}

/** Platform-specific service manager interface (ISP). */
export interface ServiceManager {
  readonly name: string;

  install(opts: InstallOptions): Promise<InstallResult>;
  uninstall(): Promise<UninstallResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
  tailLogs(follow: boolean): Promise<void>;
}

/** Supported platform identifiers. */
export type PlatformId = "systemd" | "launchd" | "windows-service" | "unsupported";
