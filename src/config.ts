import {
  REQUIRED_RESOURCE_ATTRIBUTES,
  SEMCONV_STABILITY_OPT_IN,
} from './constants';

export type TelemetryConfig = {
  /** true in development, where no collector is running. */
  disabled: boolean;
  /** gRPC endpoint. No other protocol is supported. */
  endpoint: string;
  /** parent-based ratio. 1.0 keeps every trace. */
  samplingRatio: number;
  resourceAttributes: Record<string, string>;
  serviceName: string;
};

class ConfigError extends Error {
  constructor(problems: string[]) {
    super(
      `Invalid telemetry configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'See .env.example for the full set of required variables.',
    );
    this.name = 'ConfigError';
  }
}

function parseResourceAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = decodeURIComponent(trimmed.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Everything is validated here, at startup, so a misconfigured
 * service fails immediately and loudly instead of running for a week and
 * producing traces nobody can group by environment.
 *
 * All problems are collected and reported together - fixing env vars one
 * redeploy at a time is miserable.
 */
export function loadConfig(): TelemetryConfig {
  const disabled = process.env.OTEL_SDK_DISABLED === 'true';

  // In development the SDK is off entirely, so none of the
  // production-only variables are required. Bail out before validating them.
  if (disabled) {
    return {
      disabled: true,
      endpoint: '',
      samplingRatio: 0,
      resourceAttributes: {},
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'unknown_service',
    };
  }

  const problems: string[] = [];

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  if (!endpoint) {
    problems.push('OTEL_EXPORTER_OTLP_ENDPOINT is required');
  }

  // The full resource attribute set, or the dashboards cannot slice
  // by environment, region or instance.
  const resourceAttributes = parseResourceAttributes(
    process.env.OTEL_RESOURCE_ATTRIBUTES ?? '',
  );
  if (process.env.OTEL_SERVICE_NAME) {
    resourceAttributes['service.name'] ??= process.env.OTEL_SERVICE_NAME;
  }
  for (const key of REQUIRED_RESOURCE_ATTRIBUTES) {
    if (!resourceAttributes[key]) {
      problems.push(`OTEL_RESOURCE_ATTRIBUTES is missing "${key}"`);
    }
  }

  // One sampling strategy across all services, so per-endpoint rates
  // on the dashboard are comparable between them.
  const rawRatio = process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0';
  const samplingRatio = Number(rawRatio);
  if (!Number.isFinite(samplingRatio) || samplingRatio < 0 || samplingRatio > 1) {
    problems.push(`OTEL_TRACES_SAMPLER_ARG must be a number in [0,1], got "${rawRatio}"`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    disabled: false,
    endpoint,
    samplingRatio,
    resourceAttributes,
    serviceName: resourceAttributes['service.name']!,
  };
}

/**
 * This has to happen before any instrumentation module is imported,
 * so it runs at module load of the entrypoint rather than inside register().
 * Setting it late is worse than not setting it - some libraries read it once
 * on first import and others on each span, which is exactly the kind of
 * per-service drift the shared dashboard cannot absorb.
 */
export function applySemconvStabilityOptIn(): void {
  const existing = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  if (!existing) {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = SEMCONV_STABILITY_OPT_IN;
    return;
  }
  const have = new Set(existing.split(',').map((s) => s.trim()).filter(Boolean));
  for (const needed of SEMCONV_STABILITY_OPT_IN.split(',')) {
    have.add(needed);
  }
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = Array.from(have).join(',');
}
