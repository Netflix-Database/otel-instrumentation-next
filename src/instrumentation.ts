import type { Context, Span } from '@opentelemetry/api';
import { context, propagation } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { format } from 'node:util';
import { applySemconvStabilityOptIn, loadConfig } from './config';
import type { TelemetryConfig } from './config';
import { LIVENESS_PATH, READINESS_PATH, REQUEST_ID_BAGGAGE_KEY } from './constants';

// This has to run before the instrumentation imports above take
// effect on first patch, so it sits at module scope rather than inside
// registerInstrumentation().
applySemconvStabilityOptIn();

let sdk: NodeSDK | undefined;
let started = false;
let shutdownHooksInstalled = false;

/**
 * Copies the request id from baggage onto every span as it starts, so a trace
 * can be found by request id and db/redis/http spans all carry it.
 */
class BaggageToSpanAttributeProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const bag = propagation.getBaggage(parentContext ?? context.active());
    const reqId = bag?.getEntry(REQUEST_ID_BAGGAGE_KEY)?.value;
    if (reqId) span.setAttribute(REQUEST_ID_BAGGAGE_KEY, reqId);
  }
  onEnd() {}
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
}

export type RegisterOptions = {
  instrumentations?: Instrumentation[];
  ignoreRoutes?: string[];
  /**
   * Run before exporters are flushed - close db/redis/rabbit pools
   * and stop accepting work here.
   */
  onShutdown?: () => Promise<void>;
  /** Set false to install signal handlers yourself. */
  handleSignals?: boolean;
};

/**
 * Db, redis, http and rabbit spans, from the shared package so every
 * service emits the same attributes under the same semconv version.
 *
 * All five are registered unconditionally. The instrumentations are no-ops
 * unless the corresponding module is actually loaded, so a service that has no
 * Postgres simply never produces pg spans - this costs nothing and removes a
 * per-service decision that would otherwise drift.
 */
function defaultInstrumentations(cfg: TelemetryConfig, opts: RegisterOptions): Instrumentation[] {
  const ignored = new Set([LIVENESS_PATH, READINESS_PATH, ...(opts.ignoreRoutes ?? [])]);

  return [
    new HttpInstrumentation({
      // Health probes fire constantly and would dominate both trace volume and
      // the request-rate panels.
      ignoreIncomingRequestHook: (req) => {
        const url = (req.url || '').split('?')[0];
        return ignored.has(url);
      },
    }),
    new UndiciInstrumentation(),
    new PgInstrumentation(),
    new MySQL2Instrumentation(),
    new IORedisInstrumentation(),
    new RedisInstrumentation(),
    // RabbitMQ.
    new AmqplibInstrumentation(),
    // Event loop lag, GC and heap, as standard metrics.
    new RuntimeNodeInstrumentation(),
    new PinoInstrumentation({
      // trace_id/span_id are injected by this instrumentation; the
      // request id has to be pulled from baggage ourselves.
      logHook: (_span, record) => {
        const bag = propagation.getBaggage(context.active());
        const reqId = bag?.getEntry(REQUEST_ID_BAGGAGE_KEY)?.value;
        if (reqId) record[REQUEST_ID_BAGGAGE_KEY] = reqId;
      },
    }),
  ];
}

/**
 * Start instrumentation (idempotent). Returns a shutdown helper.
 */
export async function registerInstrumentation(opts: RegisterOptions = {}) {
  if (started) return { shutdown: shutdownInstrumentation };

  // Throws with every problem listed if the environment is wrong.
  const cfg = loadConfig();

  // No tracing, no metrics, no exporters in development.
  // Shutdown handlers are still installed: there is nothing to flush, but
  // onShutdown still has to close db/redis/rabbit connections, and a dev
  // process that leaks those on Ctrl-C is how connection-limit errors get
  // discovered in production instead.
  if (cfg.disabled) {
    started = true;
    if (opts.handleSignals !== false) installShutdownHandlers(opts.onShutdown);
    await patchConsoleWithLogger();
    return { shutdown: shutdownInstrumentation };
  }

  sdk = new NodeSDK({
    // The validated attribute set, applied as a real Resource rather
    // than left to the env detector, so a typo fails at startup instead of
    // producing an unlabelled service.
    resource: resourceFromAttributes(cfg.resourceAttributes),

    // Parent-based so a sampled trace stays sampled across service
    // hops - otherwise distributed traces come back with holes in them.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(cfg.samplingRatio),
    }),

    // Batch, not Simple: Simple exports one span per request and was the
    // previous behaviour here.
    spanProcessors: [
      new BaggageToSpanAttributeProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter()),
    ],

    // Logs over OTLP/gRPC like everything else.
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],

    // Standard metrics are what the shared dashboard is built on.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),

    instrumentations: [...defaultInstrumentations(cfg, opts), ...(opts.instrumentations ?? [])],
  });

  sdk.start();
  started = true;

  if (opts.handleSignals !== false) installShutdownHandlers(opts.onShutdown);

  await patchConsoleWithLogger();

  return { shutdown: shutdownInstrumentation };
}

/**
 * Drain, close dependencies, then flush the exporters.
 *
 * Order matters. Exporters are flushed last because closing a db pool can
 * itself produce spans, and anything recorded after the flush is lost - which
 * is exactly the telemetry you want when a deploy goes wrong.
 */
function installShutdownHandlers(onShutdown?: () => Promise<void>) {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  let shuttingDown = false;
  const handle = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await onShutdown?.();
    } catch (err) {
      console.error(`error during shutdown hook on ${signal}`, err);
    }
    try {
      await shutdownInstrumentation();
    } catch (err) {
      console.error(`error flushing telemetry on ${signal}`, err);
    }
  };

  process.once('SIGTERM', () => void handle('SIGTERM'));
  process.once('SIGINT', () => void handle('SIGINT'));
}

export async function shutdownInstrumentation() {
  if (!sdk || !started) {
    started = false;
    return;
  }
  await sdk.shutdown();
  started = false;
}

/**
 * Patch global console methods to route through pino, so stray console.log
 * calls still land in the log pipeline with trace correlation.
 */
async function patchConsoleWithLogger() {
  const logger = await import('./logger').then((mod) => mod.logger);

  console.log = (...args: any[]) => logger.info({ args }, format(...args));
  console.info = (...args: any[]) => logger.info({ args }, format(...args));
  console.warn = (...args: any[]) => logger.warn({ args }, format(...args));
  console.error = (...args: any[]) => logger.error({ args }, format(...args));
  console.debug = (...args: any[]) => logger.debug({ args }, format(...args));
}
