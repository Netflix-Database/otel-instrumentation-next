import { context } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import type { RPCMetadata } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * Records the route template of the request being handled, e.g.
 * `/api/:project/members`.
 *
 * The http instrumentation only knows the raw path, so without this every
 * request shows as "(no route)" on the shared dashboards - unless a framework
 * instrumentation (Express) or the framework itself (Next.js) reports it.
 * This goes through the same RPCMetadata those use: when the response
 * finishes, the http instrumentation copies it onto the server span as
 * `http.route` and renames the span to `GET /api/:project/members`.
 *
 * Call it from middleware that runs inside the request. Outside one it does
 * nothing. Pass the template, never the path: `http.route` becomes a metric
 * label, and a path with ids in it creates a new series per id.
 */
export function setHttpRoute(route: string): void {
  const meta = getRPCMetadata(context.active());
  if (meta?.type === RPCType.HTTP) meta.route = route;
}

/**
 * Hands the route Next.js resolved to the http instrumentation's server span.
 *
 * Next.js puts the route on spans of its own only. Its outermost one,
 * BaseServer.handleRequest, is dropped by the collector because it duplicates
 * the http span, and it only learns the route in a `finally` that runs after
 * the response has finished - after the http instrumentation has read the
 * route and ended its span. So neither that span nor Next's own "copy the
 * route to the parent span" (16.2+) reliably labels the request.
 *
 * The inner spans know it much earlier: "resolve page components" carries
 * `next.route` from the moment it starts, and "render route" / "executing api
 * route" end before the response goes out. The first Next.js span of the
 * request that carries `next.route` fills the RPCMetadata slot the http
 * instrumentation reads when the response finishes. That slot lives in the
 * request's context, which every span inside the request inherits.
 */
export class NextRouteSpanProcessor implements SpanProcessor {
  private readonly pending = new WeakMap<Span, RPCMetadata>();

  onStart(span: Span, parentContext: Context): void {
    if (span.attributes['next.span_type'] === undefined) return;
    const meta = getRPCMetadata(parentContext);
    if (meta?.type !== RPCType.HTTP) return;
    // Most carry the route only once they end.
    if (!take(span, meta)) this.pending.set(span, meta);
  }

  onEnd(span: ReadableSpan): void {
    const meta = this.pending.get(span as Span);
    if (!meta) return;
    this.pending.delete(span as Span);
    take(span, meta);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** Fills the slot from the span's `next.route`, unless something already did. */
function take(span: ReadableSpan, meta: RPCMetadata): boolean {
  const route = span.attributes['next.route'];
  if (typeof route !== 'string' || meta.type !== RPCType.HTTP) return false;
  // The first route wins, and one set explicitly with setHttpRoute beats all.
  if (meta.route === undefined) meta.route = route;
  return true;
}

/** Maps a request path to the route template it matched, if any. */
export type RouteMatcher = (pathname: string) => string | undefined;

type Segment = { kind: 0; value: string } | { kind: 1 } | { kind: 2 };

/**
 * Builds a matcher over file-router style templates: `:name` matches one
 * segment, `*name` (or `**`) matches the rest of the path, `(group)` segments
 * are ignored. The most specific template wins - static segments before
 * parameters, parameters before catch-alls - which is how file routers
 * (SolidStart, Nuxt, Next.js) resolve overlaps.
 */
export function createRouteMatcher(templates: readonly string[]): RouteMatcher {
  const routes = [...new Set(templates.map(normaliseTemplate))].flatMap((template) =>
    // An optional ":name?" segment matches with or without it; each variant
    // still reports the template as written.
    expandOptional(split(template)).map((parts) => ({ template, segments: parts.map(parseSegment) })),
  );
  routes.sort((a, b) => compareSpecificity(a.segments, b.segments));

  return (pathname) => {
    const parts = split(pathname.split('?')[0]).map(safeDecode);
    return routes.find((r) => matches(r.segments, parts))?.template;
  };
}

function normaliseTemplate(template: string): string {
  const path = template
    .replace(/\([^)/]*\)/g, '')
    .replace(/\/+/g, '/')
    .replace(/(.)\/$/, '$1');
  return path.startsWith('/') ? path : `/${path}`;
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function expandOptional(parts: string[]): string[][] {
  const i = parts.findIndex((p) => p.startsWith(':') && p.endsWith('?'));
  if (i < 0) return [parts];
  const without = [...parts.slice(0, i), ...parts.slice(i + 1)];
  const withIt = [...parts.slice(0, i), parts[i].slice(0, -1), ...parts.slice(i + 1)];
  return [...expandOptional(withIt), ...expandOptional(without)];
}

function parseSegment(s: string): Segment {
  if (s.startsWith('*')) return { kind: 2 };
  if (s.startsWith(':')) return { kind: 1 };
  return { kind: 0, value: s };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function matches(segments: Segment[], parts: string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 2) return true;
    if (i >= parts.length) return false;
    if (seg.kind === 0 && seg.value !== parts[i]) return false;
  }
  return segments.length === parts.length;
}

function compareSpecificity(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    // A template that has ended here only competes with a catch-all (the two
    // are the only ones that can match the same path), and must win: "/a" is
    // tried before "/a/*rest".
    const ka = a[i]?.kind ?? 1.5;
    const kb = b[i]?.kind ?? 1.5;
    if (ka !== kb) return ka - kb;
  }
  return 0;
}
