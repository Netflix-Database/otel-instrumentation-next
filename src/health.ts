/**
 * One health contract for every service, so a single Docker/compose
 * healthcheck and one Grafana panel work everywhere.
 *
 *   GET /livez  - is the process alive? Never touches a dependency.
 *   GET /readyz - can it serve traffic? Checks db/redis/rabbit.
 *
 * Keeping them separate matters: a liveness probe that checks the database
 * restarts the app when the database blips, turning a dependency outage into
 * an outage plus a restart loop.
 */

export type DependencyCheck = {
  name: string;
  /** Should reject or return false when unhealthy. Keep it cheap - SELECT 1. */
  check: () => Promise<boolean | void>;
  /**
   * When false, a failure is reported but does not make the service unready.
   * Use for things the service degrades without rather than dies without.
   */
  critical?: boolean;
};

export type HealthResult = {
  status: 'ok' | 'degraded' | 'error';
  checks: Record<string, { status: 'ok' | 'error'; error?: string; duration_ms: number }>;
};

const DEFAULT_TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} check timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Liveness: the event loop is turning and the process can answer. Deliberately
 * has no dependencies and no async work.
 */
export function livenessHandler() {
  return async (): Promise<Response> =>
    Response.json({ status: 'ok' }, { status: 200 });
}

/**
 * Readiness: every registered dependency is reachable. Returns 503 when a
 * critical check fails so load balancers and `depends_on: service_healthy`
 * hold traffic back.
 */
export function readinessHandler(checks: DependencyCheck[] = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  return async (): Promise<Response> => {
    const results: HealthResult['checks'] = {};
    let criticalFailed = false;
    let anyFailed = false;

    await Promise.all(
      checks.map(async (dep) => {
        const started = performance.now();
        try {
          const ok = await withTimeout(
            Promise.resolve(dep.check()),
            timeoutMs,
            dep.name,
          );
          if (ok === false) throw new Error('check returned false');
          results[dep.name] = { status: 'ok', duration_ms: Math.round(performance.now() - started) };
        } catch (err) {
          anyFailed = true;
          if (dep.critical !== false) criticalFailed = true;
          results[dep.name] = {
            status: 'error',
            // Dependency errors can carry connection strings with credentials,
            // so only the message is surfaced, never the stack or cause chain.
            error: err instanceof Error ? err.message : String(err),
            duration_ms: Math.round(performance.now() - started),
          };
        }
      }),
    );

    const status: HealthResult['status'] = criticalFailed
      ? 'error'
      : anyFailed
        ? 'degraded'
        : 'ok';

    return Response.json({ status, checks: results } satisfies HealthResult, {
      status: criticalFailed ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    });
  };
}
