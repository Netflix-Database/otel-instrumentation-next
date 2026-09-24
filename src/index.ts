export {
  LIVENESS_PATH,
  READINESS_PATH,
  REQUEST_ID_BAGGAGE_KEY,
  REQUEST_ID_HEADER,
  REQUIRED_RESOURCE_ATTRIBUTES,
  SEMCONV_STABILITY_OPT_IN,
  SEMCONV_VERSION,
} from './constants';
export { applySemconvStabilityOptIn, loadConfig } from './config';
export type { TelemetryConfig } from './config';
export { registerInstrumentation, shutdownInstrumentation } from './instrumentation';
export type { RegisterOptions } from './instrumentation';
export {
  currentTraceIds,
  getOrCreateRequestId,
  outboundHeaders,
  sanitizeBaggage,
  upsertBaggage,
} from './middleware';
export type { BaggagePolicy } from './middleware';
export { livenessHandler, readinessHandler } from './health';
export type { DependencyCheck, HealthResult } from './health';
export { recordError, recordErrorOnActiveSpan, withErrorRecording } from './errors';
// The logger itself stays on './logger', because importing it builds one. The
// redaction contract is side-effect free and services need it to wire their own
// transports the same way.
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
