import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

/**
 * Record the exception on the span AND set the span status to error.
 *
 * Both are needed. `recordException` alone adds an event but leaves the span
 * status UNSET, so it is not counted as a failure - which makes "error rate
 * per endpoint" and "error rate per query" silently under-report on the shared
 * dashboard. Doing it in one helper is the only way this stays consistent
 * across 29 repos.
 */
export function recordError(span: Span | undefined, err: unknown): void {
  if (!span) return;
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

/** Record against whichever span is currently active. */
export function recordErrorOnActiveSpan(err: unknown): void {
  recordError(trace.getSpan(context.active()), err);
}

/**
 * Wrap an operation so a thrown error is always recorded with the right span
 * status before it propagates. The error is rethrown untouched.
 */
export async function withErrorRecording<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    recordErrorOnActiveSpan(err);
    throw err;
  }
}
