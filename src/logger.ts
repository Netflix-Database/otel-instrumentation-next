import type { Logger as PinoLogger } from 'pino';
import pino from 'pino';

import { REDACTED_PLACEHOLDER, REDACT_PATHS, redact, redactChildBindings } from './redact';

export {
  MAX_REDACT_DEPTH,
  REDACTED_PLACEHOLDER,
  REDACT_PATHS,
  SECRET_NEEDLES,
  normaliseKey,
  redact,
  redactChildBindings,
  shouldRedact,
} from './redact';

/**
 * Pretty, human-readable logs in development; structured JSON in
 * production where the collector parses them.
 *
 * The field names are fixed here rather than per service. The
 * pino instrumentation injects trace_id/span_id, and the SDK's log hook adds
 * request.id, so every service emits the same shape and one Grafana query
 * works across all of them.
 *
 * Redaction takes three passes, because pino offers no single place
 * that sees everything a service logs - `formatters.log` for the object of
 * each call, `redactChildBindings` for bindings, and `REDACT_PATHS` for what
 * only exists once the serializers have run. All three apply the same
 * contract; see `./redact`.
 */
const isDev =
  process.env.NODE_ENV !== 'production' || process.env.OTEL_SDK_DISABLED === 'true';

const baseLogger: PinoLogger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  redact: { paths: REDACT_PATHS, censor: REDACTED_PLACEHOLDER },
  formatters: {
    // Pin the level field to a name and shape shared by the Go and .NET services.
    level: (label) => ({ level: label }),
    // Returns the same object when there is nothing to censor, so a clean line
    // costs one walk and no allocation.
    log: (object) => redact(object),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export const logger: PinoLogger = redactChildBindings(baseLogger);
