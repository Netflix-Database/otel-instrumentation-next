'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const pino = require('pino');

const {
  MAX_REDACT_DEPTH,
  REDACTED_PLACEHOLDER,
  REDACT_PATHS,
  normaliseKey,
  redact,
  redactChildBindings,
  shouldRedact,
} = require('../lib/redact');

// The cases below are the shared contract, and the same table is asserted in
// otel-instrumentation-go and Netdb.Observability. A name that redacts in one
// language must redact in all three.
test('shouldRedact matches the shared contract', () => {
  const redacted = [
    'password', 'Password', 'PASSWORD', 'passwd', 'userPassword',
    'secret', 'clientSecret', 'client_secret', 'sessionSecret',
    'token', 'accessToken', 'access_token', 'refresh_token', 'Refresh-Token',
    'apikey', 'apiKey', 'api_key', 'X-API-KEY', 'Api.Key', 'x-api-key',
    'authorization', 'Authorization', 'proxy-authorization',
    'cookie', 'Cookie', 'set-cookie',
    'credential', 'db_credential', 'Credentials',
  ];
  for (const name of redacted) {
    assert.equal(shouldRedact(name), true, `${name} should be redacted`);
  }

  const kept = [
    'username', 'user_id', 'email', 'duration_ms', 'trace_id', 'span_id',
    'request.id', 'service.name', 'status_code', 'message',
  ];
  for (const name of kept) {
    assert.equal(shouldRedact(name), false, `${name} should not be redacted`);
  }
});

test('normaliseKey strips separators and case', () => {
  // The "x" prefix survives - matching is substring-based, so "xapikey" still
  // contains "apikey" and is redacted.
  assert.equal(normaliseKey('X-API-KEY'), 'xapikey');
  assert.equal(normaliseKey('api_key'), 'apikey');
  assert.equal(normaliseKey('Api.Key'), 'apikey');
  assert.equal(normaliseKey('Client Secret'), 'clientsecret');
});

// Rule 4 of the contract, and the gap this replaced: the old path list caught
// "apiKey" at one level deep and nothing else.
test('redact censors nested fields at any depth', () => {
  const out = redact({
    id: 7,
    user: {
      name: 'yannick',
      password: 'hunter2',
      session: { refreshToken: 'rt-1', 'x-custom-token': 'ct-1' },
    },
  });

  assert.equal(out.user.password, REDACTED_PLACEHOLDER);
  assert.equal(out.user.session.refreshToken, REDACTED_PLACEHOLDER);
  assert.equal(out.user.session['x-custom-token'], REDACTED_PLACEHOLDER);
  assert.equal(out.user.name, 'yannick');
  assert.equal(out.id, 7);
});

// A matching key is never inspected, whatever it holds.
test('a matching key has its whole value replaced', () => {
  const out = redact({ credentials: { user: 'a', pass: 'b' }, tokens: ['a', 'b'] });
  assert.equal(out.credentials, REDACTED_PLACEHOLDER);
  assert.equal(out.tokens, REDACTED_PLACEHOLDER);
});

test('redact reaches into arrays', () => {
  const out = redact({ sessions: [{ user: 'a', token: 'tok-a' }, { user: 'b', token: 'tok-b' }] });
  assert.equal(out.sessions[0].token, REDACTED_PLACEHOLDER);
  assert.equal(out.sessions[1].token, REDACTED_PLACEHOLDER);
  assert.equal(out.sessions[0].user, 'a');
});

// Redaction that reshapes every log line is redaction people turn off.
test('a clean object is returned as the same instance', () => {
  const input = { id: 7, user: { name: 'yannick' } };
  assert.equal(redact(input), input);
});

test('only the branches holding a secret are copied', () => {
  const clean = { name: 'yannick' };
  const input = { clean, dirty: { token: 'tok-1' } };
  const out = redact(input);

  assert.notEqual(out, input);
  assert.equal(out.clean, clean, 'a clean branch should not be copied');
  assert.equal(input.dirty.token, 'tok-1', 'the input must not be mutated');
});

test('class instances are passed through rather than walked', () => {
  class Session {
    constructor() {
      this.token = 'tok-1';
    }
  }
  const session = new Session();

  // "session" does not match and the value is not a plain object, so it is left
  // for its own serializer to handle rather than walked on every log call.
  assert.equal(redact({ session }).session, session);
});

test('a cyclic object terminates', () => {
  const a = { name: 'a', token: 'tok-1' };
  a.self = a;

  assert.equal(redact({ graph: a }).graph.token, REDACTED_PLACEHOLDER);
});

function nest(depth, leaf) {
  let out = leaf;
  for (let i = 0; i < depth; i++) out = { nested: out };
  return out;
}

// The cap is a documented limit, asserted so that changing it is deliberate.
test('the walk stops at MAX_REDACT_DEPTH', () => {
  const within = JSON.stringify(redact(nest(MAX_REDACT_DEPTH - 2, { token: 'tok-1' })));
  assert.equal(within.includes('tok-1'), false, 'a secret within the cap must be censored');

  const beyond = JSON.stringify(redact(nest(MAX_REDACT_DEPTH + 2, { token: 'tok-2' })));
  assert.equal(beyond.includes('tok-2'), true, 'beyond the cap the walk stops, by design');
});

/** A logger wired exactly like the exported one, writing into an array. */
function capture() {
  const lines = [];
  const logger = redactChildBindings(
    pino(
      {
        level: 'trace',
        redact: { paths: REDACT_PATHS, censor: REDACTED_PLACEHOLDER },
        formatters: {
          level: (label) => ({ level: label }),
          log: (object) => redact(object),
        },
      },
      { write: (line) => lines.push(line) },
    ),
  );
  return { logger, output: () => lines.join('') };
}

test('secrets logged as fields never reach the stream', () => {
  const { logger, output } = capture();
  logger.info(
    {
      username: 'yannick',
      password: 'hunter2',
      'x-custom-token': 'ct-1',
      user: { apiKey: 'ak-1' },
    },
    'login',
  );

  const out = output();
  for (const leak of ['hunter2', 'ct-1', 'ak-1']) {
    assert.equal(out.includes(leak), false, `${leak} leaked: ${out}`);
  }
  assert.equal(out.includes('yannick'), true);
});

// pino's child() bypasses formatters.bindings entirely, so per-request loggers
// need their own pass - the Go library's .With() equivalent.
test('secrets in child bindings never reach the stream', () => {
  const { logger, output } = capture();
  logger.child({ requestId: 'r-1', sessionToken: 'st-1' }).info('request');

  const out = output();
  assert.equal(out.includes('st-1'), false, `child binding leaked: ${out}`);
  assert.equal(out.includes('r-1'), true);
});

test('grandchildren inherit the binding pass', () => {
  const { logger, output } = capture();
  logger.child({ a: 1 }).child({ clientSecret: 'cs-1' }).info('request');

  assert.equal(output().includes('cs-1'), false, `grandchild binding leaked: ${output()}`);
});

// The serializers run after formatters.log, so these are the paths the walk
// cannot reach and REDACT_PATHS still covers.
test('serializer output is redacted by the path list', () => {
  const lines = [];
  const logger = pino(
    {
      level: 'trace',
      redact: { paths: REDACT_PATHS, censor: REDACTED_PLACEHOLDER },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object),
      },
      serializers: {
        req: (request) => ({ method: request.method, headers: request.headers }),
      },
    },
    { write: (line) => lines.push(line) },
  );

  // Not a plain object, so the walk skips it and only the serializer sees it.
  class IncomingMessageish {
    constructor() {
      this.method = 'GET';
      this.headers = { authorization: 'Bearer abc', cookie: 'session=1', accept: '*/*' };
    }
  }
  logger.info({ req: new IncomingMessageish() }, 'request');

  const out = lines.join('');
  assert.equal(out.includes('Bearer abc'), false, `authorization header leaked: ${out}`);
  assert.equal(out.includes('session=1'), false, `cookie header leaked: ${out}`);
  assert.equal(out.includes('GET'), true);
});
