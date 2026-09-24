/**
 * Cross-service constants. Every Netdb service must agree on these values or
 * the shared Grafana dashboards cannot join traces, logs and metrics together.
 */

/** one request-id header across every service, in every language. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Baggage key the request id travels under, and the span attribute it lands on. */
export const REQUEST_ID_BAGGAGE_KEY = 'request.id';

/** identical health paths everywhere, so one Docker/K8s probe config fits all. */
export const LIVENESS_PATH = '/livez';
export const READINESS_PATH = '/readyz';

/**
 * The OpenTelemetry semantic convention version this package emits.
 * Attribute names moved between versions (db.statement -> db.query.text,
 * db.system -> db.system.name), so the dashboards are built against exactly
 * this version. Bumping it is a breaking change for those dashboards.
 */
export const SEMCONV_VERSION = '1.43.0';

/**
 * Must be set before any instrumentation module is loaded, otherwise
 * each library falls back to its own default convention version and the
 * database/http attribute names diverge between services.
 */
export const SEMCONV_STABILITY_OPT_IN = 'database,http';

/**
 * Resource attributes every service must report. Validated at
 * startup rather than defaulted, because a missing one silently produces
 * traces that cannot be filtered by environment or region on the dashboard.
 */
export const REQUIRED_RESOURCE_ATTRIBUTES = [
  'service.name',
  'service.version',
  'service.instance.id',
  'deployment.environment.name',
  'cloud.region',
] as const;

/**
 * An incoming request id is attacker-controlled at the edge. It ends up in log
 * lines and span attributes, so it is length-capped and character-restricted
 * to stop log forging and metric cardinality blow-ups.
 */
export const REQUEST_ID_MAX_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
