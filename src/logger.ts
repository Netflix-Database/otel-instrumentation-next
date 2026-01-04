import type { Logger as PinoLogger } from "pino";
import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

let loggerInstance: PinoLogger | undefined;

export function getLogger(): PinoLogger {
  if (!loggerInstance) {
    loggerInstance = (isProd
      ? pino()
      : (pino.transport({ target: "pino-pretty", options: { colorize: true } }) as unknown as PinoLogger));
  }
  return loggerInstance;
}

// Backward-compatible `logger` export: a thin proxy that creates the real logger on first use.
// This keeps existing import sites working while avoiding eager creation at module import time.
export const logger: PinoLogger = new Proxy({} as PinoLogger, {
  get(_, prop: string | symbol) {
    const real = getLogger();
    const val = (real as any)[prop];
    if (typeof val === 'function') return val.bind(real);
    return val;
  },
}) as PinoLogger;
