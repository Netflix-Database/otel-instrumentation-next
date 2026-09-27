'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createRouteMatcher } = require('../lib/route');

// Shaped like SolidStart's file routes: groups, params, a catch-all 404.
const match = createRouteMatcher([
  '/',
  '/api/projects',
  '/api/:project/members',
  '/(auth)/login',
  '/:project',
  '/:project/issues',
  '/:project/issues/new',
  '/:project/issues/:issue',
  '/*404',
]);

test('static routes match exactly', () => {
  assert.equal(match('/'), '/');
  assert.equal(match('/api/projects'), '/api/projects');
});

test('parameters match one segment and keep the template', () => {
  assert.equal(match('/api/acme/members'), '/api/:project/members');
  assert.equal(match('/acme/issues/42'), '/:project/issues/:issue');
});

// "/acme/issues/new" matches both ".../new" and ".../:issue"; the static one
// must win, as it does in the file router.
test('static segments beat parameters', () => {
  assert.equal(match('/acme/issues/new'), '/:project/issues/new');
  assert.equal(match('/api/projects'), '/api/projects');
});

test('route groups are dropped from the template', () => {
  assert.equal(match('/login'), '/login');
});

test('the catch-all takes whatever nothing else matches', () => {
  assert.equal(match('/acme/nope/deeper/still'), '/*404');
});

test('an exact template beats a catch-all at the same depth', () => {
  const m = createRouteMatcher(['/docs/*rest', '/docs']);
  assert.equal(m('/docs'), '/docs');
  assert.equal(m('/docs/a/b'), '/docs/*rest');
});

test('trailing slashes, query strings and encoding do not change the match', () => {
  assert.equal(match('/acme/issues/'), '/:project/issues');
  assert.equal(match('/acme/issues?sort=asc'), '/:project/issues');
  assert.equal(match('/api/projects%2F/members'), '/api/:project/members');
});

// SolidStart turns [[lang]] into ":lang?".
test('optional parameters match with and without the segment', () => {
  const m = createRouteMatcher(['/docs/:lang?/intro']);
  assert.equal(m('/docs/intro'), '/docs/:lang?/intro');
  assert.equal(m('/docs/de/intro'), '/docs/:lang?/intro');
  assert.equal(m('/docs/de/fr/intro'), undefined);
});

// Index files come through with a trailing slash ("/:project/issues/").
test('index routes with a trailing slash match the bare path', () => {
  const m = createRouteMatcher(['/:project/issues/']);
  assert.equal(m('/acme/issues'), '/:project/issues');
});

test('no match returns undefined', () => {
  const m = createRouteMatcher(['/a']);
  assert.equal(m('/b'), undefined);
});

// End to end: the http instrumentation copies the route set during the
// request onto the server span and renames it.
test('setHttpRoute sets http.route and the span name on the server span', async () => {
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http';
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { SpanKind } = require('@opentelemetry/api');

  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const unregister = registerInstrumentations({ tracerProvider: provider, instrumentations: [new HttpInstrumentation()] });

  // Required only now, so the instrumentation patches it.
  const http = require('node:http');
  const { setHttpRoute } = require('../lib/route');
  const server = http.createServer((req, res) => {
    setHttpRoute(match(req.url));
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const port = server.address().port;
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/acme/issues/42`, (res) => res.resume().on('end', resolve)).on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    const serverSpan = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
    assert.ok(serverSpan, 'no server span recorded');
    assert.equal(serverSpan.attributes['http.route'], '/:project/issues/:issue');
    assert.equal(serverSpan.name, 'GET /:project/issues/:issue');
  } finally {
    server.close();
    unregister();
    await provider.shutdown();
  }
});
