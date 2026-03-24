/**
 * 提供项目模块可复用的基础日志接口。
 *
 * @module project/logger
 */

export type LoggerMetadata = Record<string, unknown>;

export type Logger = {
  debug?(message: string, metadata?: LoggerMetadata): void;
  info?(message: string, metadata?: LoggerMetadata): void;
  warn?(message: string, metadata?: LoggerMetadata): void;
  error?(message: string, metadata?: LoggerMetadata): void;
};

export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class ConsoleLogger implements Logger {
  debug(message: string, metadata?: LoggerMetadata): void {
    console.debug(formatLogMessage("DEBUG", message, metadata));
  }

  info(message: string, metadata?: LoggerMetadata): void {
    console.info(formatLogMessage("INFO", message, metadata));
  }

  warn(message: string, metadata?: LoggerMetadata): void {
    console.warn(formatLogMessage("WARN", message, metadata));
  }

  error(message: string, metadata?: LoggerMetadata): void {
    console.error(formatLogMessage("ERROR", message, metadata));
  }
}

function formatLogMessage(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  metadata?: LoggerMetadata,
): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return `[${level}] ${message}`;
  }

  return `[${level}] ${message} ${JSON.stringify(metadata)}`;
}
