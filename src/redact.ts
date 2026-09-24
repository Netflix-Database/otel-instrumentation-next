import type { Bindings, ChildLoggerOptions, Logger as PinoLogger } from 'pino';

/**
 * Names whose values must never reach the log backend.
 *
 * ## The shared redaction contract
 *
 * `otel-instrumentation-next`, `otel-instrumentation-go` and
 * `Netdb.Observability` implement the same four rules. A secret that leaks in
 * one language must leak in all three, or the contract has drifted and the
 * weakest service decides what ends up in the log backend:
 *
 * 1. A name is normalised before matching — lowercased, with `-`, `_`, `.` and
 *    spaces removed. `api_key`, `apiKey`, `X-API-KEY` and `Api.Key` all reduce
 *    to `apikey`. HTTP header names are hyphenated and headers are the most
 *    common accidental leak, so matching only the underscore spelling would
 *    miss them.
 * 2. The normalised name is substring-matched against this list. The usual leak
 *    is a field that gained a secret months after the logging call was written,
 *    so `sessionToken` and `db_credential` match too.
 * 3. A match replaces the entire value with {@link REDACTED_PLACEHOLDER},
 *    whatever the value's type — the contents of a matching key are never
 *    inspected.
 * 4. Matching applies at every depth up to {@link MAX_REDACT_DEPTH}, not only
 *    to top-level fields. `logger.info({ user })` where `user` gained a
 *    `password` field months later censors that field, not the whole object.
 *
 * This replaces the path list pino's own `redact` option takes, which matched
 * exact paths only and so caught `apiKey` but not `x-custom-token`.
 */
export const SECRET_NEEDLES = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
];

/** The value substituted for a redacted field. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * How far into a logged object the walk descends. A log line nested deeper
 * than this is unreadable anyway, and the cap bounds the cost on every call.
 */
export const MAX_REDACT_DEPTH = 8;

/**
 * Lowercases and strips the separators that distinguish snake_case,
 * kebab-case, dotted and camelCase spellings of the same field.
 */
export function normaliseKey(key: string): string {
  let out = '';
  for (const char of key.toLowerCase()) {
    if (char === '-' || char === '_' || char === '.' || char === ' ') continue;
    out += char;
  }
  return out;
}

/**
 * Whether a field with this name must be censored. Exported so a service
 * writing its own transport applies the same rule rather than inventing a
 * second, weaker one.
 */
export function shouldRedact(key: string): boolean {
  const normalised = normaliseKey(key);
  return SECRET_NEEDLES.some((needle) => normalised.includes(needle));
}

/**
 * Only plain objects are walked. A class instance — an `IncomingMessage`, a
 * `Date`, an `Error`, a socket — is left alone: descending into one means
 * walking a live object graph on every log call, and its own serializer
 * decides what it exposes anyway.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Checks each name in a set of fields and walks what is under it.
 *
 * `childDepth` is the depth its values are walked at, so the top-level call can
 * check the logged object's own names without spending a level on them - the
 * same frame the Go library checks in `redactFields` and the .NET one in
 * `Enrich`. Without that the cap here would bite one level earlier than theirs.
 */
function redactFields(
  fields: Record<string, unknown>,
  childDepth: number,
  seen: Set<object>,
): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(fields)) {
    const current = fields[key];
    const replacement = shouldRedact(key)
      ? REDACTED_PLACEHOLDER
      : redactValue(current, childDepth, seen);
    if (replacement === current) continue;
    copy ??= { ...fields };
    copy[key] = replacement;
  }
  return copy ?? fields;
}

function redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth >= MAX_REDACT_DEPTH) return value;

  if (Array.isArray(value)) {
    // Elements carry no names of their own, but may contain objects that do.
    if (seen.has(value)) return value;
    seen.add(value);
    let copy: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const replacement = redactValue(value[i], depth + 1, seen);
      if (replacement === value[i]) continue;
      copy ??= [...(value as unknown[])];
      copy[i] = replacement;
    }
    seen.delete(value);
    return copy ?? value;
  }

  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return value;

  seen.add(value);
  const redacted = redactFields(value, depth + 1, seen);
  seen.delete(value);
  return redacted;
}

/**
 * Returns `value` with every secret-named field censored at any depth.
 *
 * A value with nothing to censor is returned as the very object it came in as,
 * so a clean log line is not copied and its shape is untouched. Only the
 * branches containing a secret are rebuilt — redaction that reshapes every log
 * line is redaction people turn off.
 */
export function redact<T>(value: T): T {
  if (!isPlainObject(value)) return value;
  return redactFields(value, 0, new Set<object>([value])) as T;
}

/**
 * The paths pino's own `redact` option still covers.
 *
 * Name matching does the real work and catches far more, but it cannot see
 * everything. `formatters.log` runs *before* the serializers, so a raw
 * `req`/`res` is still an `IncomingMessage` at that point and the walk skips it
 * by design. These paths run at stringify time, on the plain object the
 * serializer produced, which is the only place those headers are visible.
 *
 * Every name here would also match by name if the walk could reach it, so the
 * two passes never disagree - one just runs later than the other.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'err.config.headers.authorization',
];

type ChildFn = (bindings: Bindings, options?: ChildLoggerOptions) => PinoLogger;

/**
 * Applies the contract to child bindings, returning the logger it was given.
 *
 * `formatters.bindings` would be the obvious hook, but pino's `child()` swaps
 * it for the identity function before serialising bindings (see
 * `resetChildingsFormatter` in `pino/lib/proto.js`), so it only ever sees the
 * root logger's pid and hostname. Without this,
 * `logger.child({ sessionToken })` would leak where the Go library's
 * `logger.With(...)` equivalent does not.
 *
 * Install this once, on the root. pino builds a child with
 * `Object.create(parent)`, so children inherit the override through the
 * prototype chain and grandchildren are covered too, while `this` stays the
 * logger the call was made on - which is what pino's own `child` needs.
 */
export function redactChildBindings<T extends PinoLogger>(logger: T): T {
  // The cast is needed because Logger's custom-level generic is invariant, so
  // its own `child` signature does not round-trip through a variable.
  const pinoChild = logger.child as unknown as ChildFn;

  Object.defineProperty(logger, 'child', {
    value: function child(
      this: PinoLogger,
      bindings: Bindings,
      options?: ChildLoggerOptions,
    ): PinoLogger {
      return pinoChild.call(this, redact(bindings), options);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  return logger;
}
