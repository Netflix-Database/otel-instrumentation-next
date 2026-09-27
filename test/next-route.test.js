'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

// Reproduces the order a real Next.js request runs in, as measured against a
// running Next.js 16.1 app: "resolve page components" carries next.route
// from the start and ends early; BaseServer.handleRequest only gets the route
// in a finally that runs after the response has finished.

process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http';
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { SpanKind, trace } = require('@opentelemetry/api');
const { NextRouteSpanProcessor } = require('../lib/route');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new NextRouteSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
let unregister;
let http;

before(() => {
  provider.register();
  unregister = registerInstrumentations({ tracerProvider: provider, instrumentations: [new HttpInstrumentation()] });
  // Required only now, so the instrumentation patches it.
  http = require('node:http');
});

after(async () => {
  unregister();
  await provider.shutdown();
});

/** Serves one request with `handler`, returns the http instrumentation's span. */
async function serve(handler, path) {
  exporter.reset();
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  try {
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.address().port}${path}`, (res) => res.resume().on('end', resolve)).on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    return exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER && s.attributes['next.span_type'] === undefined);
  } finally {
    server.close();
  }
}

const tracer = () => trace.getTracer('next.js');

test('the route from an inner Next.js span labels the http span', async () => {
  const httpSpan = await serve((req, res) => {
    tracer().startActiveSpan(
      'GET',
      { kind: SpanKind.SERVER, attributes: { 'next.span_type': 'BaseServer.handleRequest' } },
      (outer) => {
        tracer()
          .startSpan('resolve page components', {
            attributes: { 'next.span_type': 'NextNodeServer.findPageComponents', 'next.route': '/blog/[slug]' },
          })
          .end();
        // The response finishes first; Next labels its outer span afterwards.
        res.end('ok', () => {
          setImmediate(() => {
            outer.setAttributes({ 'next.route': '/blog/[slug]', 'http.route': '/blog/[slug]' });
            outer.end();
          });
        });
      },
    );
  }, '/blog/hello');

  assert.ok(httpSpan, 'no http server span recorded');
  assert.equal(httpSpan.attributes['http.route'], '/blog/[slug]');
  assert.equal(httpSpan.name, 'GET /blog/[slug]');
});

// Without an inner span carrying the route, the late one on the outer span
// cannot help - which is why the processor does not rely on it.
test('a route that arrives after the response finished is not applied', async () => {
  const httpSpan = await serve((req, res) => {
    tracer().startActiveSpan('GET', { kind: SpanKind.SERVER, attributes: { 'next.span_type': 'BaseServer.handleRequest' } }, (outer) => {
      res.end('ok', () => {
        setImmediate(() => {
          outer.setAttribute('next.route', '/late');
          outer.end();
        });
      });
    });
  }, '/late');

  assert.ok(httpSpan, 'no http server span recorded');
  assert.equal(httpSpan.attributes['http.route'], undefined);
});

// Route handlers and requests fully answered before the response ends still
// work through the outer span.
test('an outer span that ends before the response still labels the http span', async () => {
  const httpSpan = await serve((req, res) => {
    tracer().startActiveSpan('GET', { kind: SpanKind.SERVER, attributes: { 'next.span_type': 'BaseServer.handleRequest' } }, (outer) => {
      outer.setAttribute('next.route', '/api/items');
      outer.end();
      res.end('ok');
    });
  }, '/api/items');

  assert.equal(httpSpan.attributes['http.route'], '/api/items');
});
