import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import { safeEqual, type Config } from '@mediaradar/core';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'mediaradar_' });

export const httpDuration = new client.Histogram({
  name: 'mediaradar_http_request_duration_seconds',
  help: 'Длительность HTTP-запросов',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const wsConnections = new client.Gauge({ name: 'mediaradar_ws_connections', help: 'Открытые WebSocket-соединения', registers: [registry] });

export function registerMetrics(app: FastifyInstance, config: Config): void {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    if (route === '/metrics' || route === '/healthz') return;
    httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });

  app.get('/metrics', { config: { access: 'public' } }, async (req, reply) => {
    // В production доступ только по токену; в разработке — ещё и с локального адреса.
    const auth = req.headers.authorization ?? '';
    const tokenOk = !!config.METRICS_TOKEN && safeEqual(auth, `Bearer ${config.METRICS_TOKEN}`);
    const local = !config.isProd && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
    if (!tokenOk && !local) return reply.status(403).send({ code: 'forbidden', detail: 'Доступ к метрикам закрыт' });
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}
