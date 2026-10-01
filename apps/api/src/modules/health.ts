import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: процесс жив
  app.get('/healthz', { config: { access: 'public' } }, async () => ({ status: 'ok' }));

  // Readiness: можно принимать трафик (БД и внешние зависимости доступны)
  app.get('/readyz', { config: { access: 'public' } }, async (_req, reply) => {
    const checks: Record<string, boolean> = { database: await app.deps.db.ping() };
    for (const [name, fn] of Object.entries(app.deps.checks ?? {})) {
      try {
        checks[name] = await fn();
      } catch {
        checks[name] = false;
      }
    }
    const ok = Object.values(checks).every(Boolean);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });
}
