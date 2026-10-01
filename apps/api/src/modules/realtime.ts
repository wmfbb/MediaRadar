import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { allowedOrigins } from '../plugins/security';
import { wsConnections } from '../plugins/metrics';
import { requireAuth, type Access } from '../plugins/auth';

const MAX_CONNECTIONS_PER_USER = 5;

export const feedChannel = (tenantId: string) => `tenant:${tenantId}:feed`;

/**
 * Поток событий в реальном времени. Аутентификация — cookie сессии при рукопожатии.
 * Клиент получает только события своего тенанта (канал tenant:{id}:feed); пользователям с ограничением
 * по темам события других тем не отправляются.
 */
export async function realtimeRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const { bus, config } = app.deps;
  const origins = allowedOrigins(config);
  const perUser = new Map<string, number>();

  app.get('/ws', { websocket: true, onRequest: access.tenant('feed:read').onRequest, config: { access: 'tenant:feed:read' } }, async (socket: WebSocket, req) => {
    const a = requireAuth(req);
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return socket.close(1008, 'origin not allowed');
    const open = perUser.get(a.userId) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_USER) return socket.close(1008, 'too many connections');
    perUser.set(a.userId, open + 1);
    wsConnections.inc();

    const topics = a.scope.topics ?? [];
    const send = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };
    const unsubscribe = await bus.subscribe(feedChannel(a.tenantId!), (payload) => {
      const p = payload as { topic?: string };
      if (topics.length && p.topic && !topics.includes(p.topic)) return;
      send({ type: 'article', data: payload });
    });
    send({ type: 'hello', tenantId: a.tenantId, time: new Date().toISOString() });

    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000);
    socket.on('message', () => {
      /* клиентские сообщения не используются; подписки определяются сессией */
    });
    socket.on('close', () => {
      clearInterval(ping);
      void unsubscribe();
      wsConnections.dec();
      const left = (perUser.get(a.userId) ?? 1) - 1;
      if (left <= 0) perUser.delete(a.userId);
      else perUser.set(a.userId, left);
    });
  });
}
