type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ENV_LEVEL = (process.env.UMANS_LOG_LEVEL ?? "info") as LogLevel;
const globalMinPriority = LEVEL_PRIORITY[ENV_LEVEL] ?? LEVEL_PRIORITY.info;

interface LogContext {
  captureId?: string | number;
  module?: string;
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

export function createLogger(module: string): Logger {
  return makeLogger({ module });
}

function makeLogger(baseCtx: LogContext): Logger {
  const log = (level: LogLevel, msg: string, ctx?: LogContext) => {
    if (LEVEL_PRIORITY[level] < globalMinPriority) return;
    const merged = ctx ? { ...baseCtx, ...ctx } : baseCtx;
    const ctxStr =
      Object.keys(merged).length > 0
        ? ` ${Object.entries(merged)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}`
        : "";
    const line = `[${level}] ${msg}${ctxStr}`;
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    debug: (m, c) => log("debug", m, c),
    info: (m, c) => log("info", m, c),
    warn: (m, c) => log("warn", m, c),
    error: (m, c) => log("error", m, c),
    child: (ctx) => makeLogger({ ...baseCtx, ...ctx }),
  };
}
