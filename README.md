# otel-instrumentation-next

Shared OpenTelemetry, logging and health wiring for Netdb's Node/Next.js
services. Services depend on this package instead of configuring the SDK
themselves, so every service emits the same span attributes, the same log
schema and the same metrics — which is what makes one Grafana dashboard work
across all of them.

## Installation

```
npm i @netflix-database/otel-instrumentation-next
```

## Usage

`instrumentation.ts` at the project root:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const otel = await import('@netflix-database/otel-instrumentation-next');
  await otel.registerInstrumentation({
    // Close your pools here. Runs before exporters are flushed.
    onShutdown: async () => {
      await db.end();
      await redis.quit();
    },
  });
}
```

Do **not** guard this with `NODE_ENV !== 'development'`. Set
`OTEL_SDK_DISABLED=true` in dev instead — the package then skips all exporters
but still installs shutdown handlers and switches pino to pretty output.

### Health endpoints

Every service exposes the same two paths, so one probe config fits all:

```ts
// app/livez/route.ts
import { livenessHandler } from '@netflix-database/otel-instrumentation-next';
export const GET = livenessHandler();

// app/readyz/route.ts
import { readinessHandler } from '@netflix-database/otel-instrumentation-next';
export const GET = readinessHandler([
  { name: 'db', check: () => db.query('SELECT 1') },
  { name: 'redis', check: () => redis.ping() },
  { name: 'search', check: () => search.ping(), critical: false },
]);
```

`/livez` never touches a dependency — a liveness probe that checks the database
restarts the app whenever the database blips. `/readyz` returns 503 when a
critical check fails, and `degraded` + 200 when only non-critical ones do.

Both paths are excluded from HTTP tracing automatically.

### Request id and baggage

```ts
import {
  getOrCreateRequestId,
  sanitizeBaggage,
  outboundHeaders,
} from '@netflix-database/otel-instrumentation-next';

const requestId = getOrCreateRequestId(req.headers);

// At a public edge, leave trustInboundBaggage unset: inbound baggage is
// dropped entirely. Only set it true for calls from our own services.
const baggage = sanitizeBaggage(req.headers.get('baggage'), requestId);

// Outbound calls to internal services carry the id and trace context on.
await fetch(url, { headers: outboundHeaders({ 'content-type': 'application/json' }) });
```

An inbound `x-request-id` is reused only if it is at most 128 characters and
matches `[A-Za-z0-9_.:-]+`. The value reaches log lines and span attributes, so
an unchecked one is a log-forging and metric-cardinality problem.

### Errors on spans

```ts
import { withErrorRecording, recordErrorOnActiveSpan } from '@netflix-database/otel-instrumentation-next';

await withErrorRecording(async () => handler(req));
```

`recordException` alone leaves the span status UNSET, so the span is not
counted as a failure and "error rate per endpoint" under-reports. These helpers
always do both.

## What is instrumented

HTTP (in and out), undici/fetch, Postgres, MySQL2, ioredis, node-redis,
amqplib (RabbitMQ), pino, and Node runtime metrics (event loop lag, GC, heap).

All are registered unconditionally — an instrumentation whose module is never
loaded is a no-op, which removes a per-service decision that would otherwise
drift.

## Configuration

All of it is validated at startup by `loadConfig()`, which reports every
problem at once rather than one redeploy at a time. See `.env.example`.

| Variable | Notes |
|---|---|
| `OTEL_SDK_DISABLED` | `true` in dev. Nothing else is then required. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector endpoint. Use the gRPC port (4317) - the exporters are gRPC. |
| `OTEL_RESOURCE_ATTRIBUTES` | Must contain `service.name`, `service.version`, `service.instance.id`, `deployment.environment.name`, `cloud.region`. |
| `OTEL_TRACES_SAMPLER_ARG` | Parent-based ratio, 0.0–1.0, default 1.0. |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Set to `database,http` automatically; your value is merged, not replaced. |
| `LOG_LEVEL` | Defaults to `debug` in dev, `info` in production. |

`service.version` should be the build's git SHA, passed as a Docker build arg,
so a trace identifies which build produced it.

## Semantic conventions

This package emits **semconv 1.43.0** and sets
`OTEL_SEMCONV_STABILITY_OPT_IN=database,http` at module load, before any
instrumentation patches its target.

Attribute names moved between versions — `db.statement` became `db.query.text`,
`db.system` became `db.system.name`. The shared dashboards are built against
this version, so bumping it is a breaking change for them and needs to happen
across all languages at once.

## Logging

pino, with `trace_id`/`span_id` injected by the OTel pino instrumentation and
`request.id` pulled from baggage. Logs are exported over OTLP/gRPC alongside
traces and metrics.

Secrets are redacted before anything reaches a sink, under a contract shared
verbatim with the other two libraries — a secret that leaks in one language must
leak in all three, or the weakest service decides what ends up in the log
backend:

1. A name is **normalised** before matching: lowercased, with `-`, `_`, `.` and
   spaces removed. `api_key`, `apiKey`, `X-API-KEY` and `Api.Key` all reduce to
   `apikey`. HTTP header names are hyphenated and headers are the most common
   accidental leak.
2. The normalised name is **substring-matched** against `password`, `passwd`,
   `secret`, `token`, `apikey`, `authorization`, `cookie`, `credential`. The
   usual leak is a field that gained a secret months after the logging call was
   written, so `sessionToken` and `db_credential` match too.
3. A match replaces the **entire value** with `[redacted]`, whatever its type —
   the contents of a matching key are never inspected.
4. Matching applies at **every depth** up to 8, not only to top-level fields.

A value with nothing to censor is passed through as the instance it arrived as,
so clean log lines keep their exact shape and cost one walk with no allocation.
Only the branches holding a secret are rebuilt.

It takes three passes, because pino offers no single place that sees everything
a service logs: `formatters.log` for the object of each call,
`redactChildBindings` for `logger.child(...)` bindings (pino's `child()`
deliberately bypasses `formatters.bindings`), and `REDACT_PATHS` for what only
exists once the serializers have run — a raw `req`/`res` is still an
`IncomingMessage` when the walk sees it, and is skipped by design. All three
passes apply the same contract.

`shouldRedact` and `redact` are exported, so a service wiring its own transport
applies the same rule rather than inventing a second, weaker one.

`console.*` is patched to route through pino so stray calls still get trace
correlation.
