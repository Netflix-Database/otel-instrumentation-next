import { context, propagation, trace } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import {
  REQUEST_ID_BAGGAGE_KEY,
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_PATTERN,
} from './constants';

/**
 * An incoming request id is only reused when it looks like one we
 * could have produced. Anything else gets a fresh id.
 *
 * The value is echoed into every log line and span attribute for the request,
 * so an unchecked header is a log-forging vector (newlines) and a metric
 * cardinality bomb (unbounded distinct values). Rejecting is silent and safe:
 * the caller still gets a usable id back, just not theirs.
 */
export function getOrCreateRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER)?.trim();
  if (
    incoming &&
    incoming.length <= REQUEST_ID_MAX_LENGTH &&
    REQUEST_ID_PATTERN.test(incoming)
  ) {
    return incoming;
  }
  return randomUUID();
}

export type BaggagePolicy = {
  /**
   * Whether the caller is inside our own network. Public edges must leave this
   * false: baggage propagates verbatim to every downstream service, so an
   * untrusted client could otherwise inject arbitrary keys that land on spans
   * and in logs across the whole system.
   */
  trustInboundBaggage?: boolean;
  /** Keys kept from inbound baggage when trusted. Defaults to the request id. */
  allowedKeys?: string[];
};

/**
 * Normalise inbound baggage before it enters the context.
 *
 * Untrusted callers get their baggage dropped entirely. Trusted callers keep
 * only allow-listed keys - a compromised internal service should not be able
 * to smuggle arbitrary attributes onto everyone else's spans either.
 *
 * `traceparent` is deliberately left alone: dropping it would break
 * distributed traces, and unlike baggage it is structurally validated by the
 * propagator and carries no free-form values.
 */
export function sanitizeBaggage(
  inbound: string | null,
  requestId: string,
  policy: BaggagePolicy = {},
): string {
  const allowed = new Set(policy.allowedKeys ?? [REQUEST_ID_BAGGAGE_KEY]);
  const kept: Array<[string, string]> = [];

  if (policy.trustInboundBaggage && inbound) {
    for (const part of inbound.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      // Strip any ;metadata suffix - we do not propagate baggage properties.
      const value = trimmed.slice(eq + 1).split(';')[0].trim();
      if (!allowed.has(decodeURIComponent(key))) continue;
      if (key === encodeURIComponent(REQUEST_ID_BAGGAGE_KEY)) continue;
      kept.push([key, value]);
    }
  }

  // Our request id always wins over anything inbound.
  kept.push([
    encodeURIComponent(REQUEST_ID_BAGGAGE_KEY),
    encodeURIComponent(requestId),
  ]);

  return kept.map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * Upsert a key-value pair into a baggage string.
 */
export function upsertBaggage(baggage: string | null, key: string, value: string) {
  const encKey = encodeURIComponent(key);
  const encVal = encodeURIComponent(value);

  const parts = (baggage ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const map = new Map<string, string>();
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (!k || rest.length === 0) continue;
    map.set(k.trim(), rest.join('=').split(';')[0].trim());
  }

  map.set(encKey, encVal);

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/**
 * Headers to attach to an outbound request so the request id and trace
 * context reach the next service. Call this for every fetch to an internal
 * service; the undici instrumentation injects `traceparent` on its own, but
 * only this adds the request id header downstream services read.
 */
export function outboundHeaders(base?: HeadersInit): Headers {
  const headers = new Headers(base);
  const bag = propagation.getBaggage(context.active());
  const requestId = bag?.getEntry(REQUEST_ID_BAGGAGE_KEY)?.value;
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId);
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => (carrier as Headers).set(key, value),
  });
  return headers;
}

/** The active trace/span ids, for log correlation. */
export function currentTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
