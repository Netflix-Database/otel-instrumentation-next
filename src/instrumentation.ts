import type { Context, Span } from '@opentelemetry/api';
import { context, propagation } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { format } from 'node:util';
import { REQUEST_ID_BAGGAGE_KEY } from './constants';
import { getLogger } from './logger';

// minimal runtime state
let sdk: NodeSDK | undefined;
let started = false;

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
};

/**
 * Start instrumentation (idempotent). Returns a shutdown helper.
 */
export async function registerInstrumentation(opts: RegisterOptions = {}) {
  if (started) return { shutdown: shutdownInstrumentation };

  sdk = new NodeSDK({
    spanProcessors: [new BaggageToSpanAttributeProcessor(), new SimpleSpanProcessor(new OTLPTraceExporter())],
    logRecordProcessors: [new SimpleLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      ...(opts.instrumentations || []),
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => (req.url || '') === '/api/health' || (opts.ignoreRoutes || []).includes(req.url || ''),
      }),
      new UndiciInstrumentation(),
      new PinoInstrumentation({
        logHook: (span, record) => {
          const bag = propagation.getBaggage(context.active());
          const reqId = bag?.getEntry(REQUEST_ID_BAGGAGE_KEY)?.value;

          if (reqId) record.request_id = reqId;
        },
      }),
    ],
  });

  sdk.start();
  started = true;

  await patchConsoleWithLogger();

  return { shutdown: shutdownInstrumentation };
}

export async function shutdownInstrumentation() {
  if (!sdk || !started) return;
  await sdk.shutdown();
  started = false;
}

/**
 * Patch global console methods to use a provided logger (pino-like). This is optional and should be used with care.
 */
async function patchConsoleWithLogger() {
  const logger = getLogger();

  console.log = (...args: any[]) => logger.info({ args }, format(...args));
  console.info = (...args: any[]) => logger.info({ args }, format(...args));
  console.warn = (...args: any[]) => logger.warn({ args }, format(...args));
  console.error = (...args: any[]) => logger.error({ args }, format(...args));
  console.debug = (...args: any[]) => logger.debug({ args }, format(...args));
} 