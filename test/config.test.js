'use strict';

const assert = require('node:assert/strict');
const { hostname } = require('node:os');
const { test, beforeEach } = require('node:test');

const { loadConfig } = require('../lib/config');

const KEYS = [
  'OTEL_SDK_DISABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SERVICE_NAME',
  'OTEL_TRACES_SAMPLER_ARG',
  'GIT_SHA',
];

const STATIC_ATTRIBUTES =
  'service.name=svc,deployment.environment.name=prod,cloud.region=eu-central-1';

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4317';
});

// The build SHA and container only exist at build and run time, so they must
// not have to be set by hand.
test('service.version and service.instance.id fall back to GIT_SHA and hostname', () => {
  process.env.OTEL_RESOURCE_ATTRIBUTES = STATIC_ATTRIBUTES;
  process.env.GIT_SHA = 'deadbeef';

  const cfg = loadConfig();

  assert.equal(cfg.resourceAttributes['service.version'], 'deadbeef');
  assert.equal(cfg.resourceAttributes['service.instance.id'], hostname());
});

test('explicit attributes win over the fallbacks', () => {
  process.env.OTEL_RESOURCE_ATTRIBUTES =
    `${STATIC_ATTRIBUTES},service.version=abc123,service.instance.id=i-1`;
  process.env.GIT_SHA = 'deadbeef';

  const cfg = loadConfig();

  assert.equal(cfg.resourceAttributes['service.version'], 'abc123');
  assert.equal(cfg.resourceAttributes['service.instance.id'], 'i-1');
});

// No silent default in production: a build without GIT_SHA still fails.
test('missing GIT_SHA is reported', () => {
  process.env.OTEL_RESOURCE_ATTRIBUTES = STATIC_ATTRIBUTES;

  assert.throws(loadConfig, (err) => {
    assert.match(err.message, /"service\.version"/);
    assert.doesNotMatch(err.message, /service\.instance\.id/);
    return true;
  });
});
