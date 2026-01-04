# otel-instrumentation-next

OpenTelemetry instrumentation helpers for Next.js Node runtime apps.

## Installation

```
npm i @netflix-database/otel-instrumentation-next
```

## Usage

Example usage in a Next.js `instrumentation.ts` file:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV !== 'development') {
    const mod = await import('@netflix-database/otel-instrumentation-next')
    // You can pass additional instrumentations (e.g., Prisma) and routes to ignore
    await mod.registerInstrumentation({ instrumentations: [], ignoreRoutes: ['/internal/health'] })
  }
}
```

Behavior notes:

- `registerInstrumentation(options)` is idempotent and returns an object with a `shutdown()` helper.
- Options:
  - `instrumentations?: Instrumentation[]` — add or override instrumentations.
  - `ignoreRoutes?: string[]` — additional routes to ignore for the HTTP instrumentation.
- The module will attempt to patch global `console.*` to route through a Pino-like logger if a compatible `./logger` module is available in your deployment (this is performed at startup).
- Service name resolution: if you do not explicitly configure a service name, the SDK will rely on resource detectors (e.g., `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`) to determine the service name automatically.

Environment variables

You can control exporter endpoints and the service name using environment variables (a simple `.env` is supported by many setups). Example `.env` (also added to the repo as `.env.example`):

```bash
OTEL_SERVICE_NAME=mambo-plus
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

APIs:

- `registerInstrumentation(options)` — start instrumentation and exporters (idempotent).
- `shutdownInstrumentation()` — gracefully shut down the SDK.

## Notes

This package targets Node runtime parts of Next.js. The middleware helper is Express-style and intended for Node server (API routes, custom servers). For Edge runtimes use a different approach.
