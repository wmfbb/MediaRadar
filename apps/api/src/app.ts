import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from './deps';
import { createAccess, type Access } from './plugins/auth';
import { registerErrors } from './plugins/errors';
import { registerMetrics } from './plugins/metrics';
import { registerSecurity } from './plugins/security';
import { healthRoutes } from './modules/health';
import { authRoutes } from './modules/auth';
import { realtimeRoutes } from './modules/realtime';
import { tenantRoutes } from './modules/tenant';
import { settingsRoutes } from './modules/settings';
import { feedRoutes } from './modules/feed';
import { dashboardRoutes } from './modules/dashboard';
import { profileRoutes } from './modules/profiles';
import { sourcesRoutes } from './modules/sources';
import { workspaceRoutes } from './modules/workspace';
import { adminRoutes } from './modules/admin';

export interface AppOptions {
  /** Ограничение частоты запросов. По умолчанию включено везде, кроме тестов. */
  rateLimit?: boolean;
  /** Swagger UI (/docs). По умолчанию — только вне production. */
  docs?: boolean;
}

export interface RouteRecord {
  method: string;
  url: string;
  access: string | undefined;
}
declare module 'fastify' {
  interface FastifyInstance {
    routeTable: RouteRecord[];
  }
}

type RouteModule = (app: FastifyInstance, access: Access) => Promise<void>;

export async function buildApp(deps: AppDeps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
        censor: '[скрыто]',
      },
    },
    trustProxy: config.TRUST_PROXY,
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && /^[\w.-]{8,64}$/.test(req.headers['x-request-id'])
        ? req.headers['x-request-id']
        : randomUUID(),
    bodyLimit: 1_048_576,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('deps', deps);
  app.decorate('routeTable', [] as RouteRecord[]);
  app.decorateRequest('auth', null);
  app.decorateRequest('authResolved', false);
  app.addHook('onRoute', (r) => {
    for (const method of Array.isArray(r.method) ? r.method : [r.method])
      if (method !== 'HEAD' && method !== 'OPTIONS')
        app.routeTable.push({
          method,
          url: r.url,
          access: (r.config as { access?: string } | undefined)?.access,
        });
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });

  registerErrors(app);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: config.isProd ? undefined : false });
  if (opts.rateLimit ?? !config.isTest)
    await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  const docs = opts.docs ?? !config.isProd;
  if (docs) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'МедиаРадар API',
          version: '0.1.0',
          description:
            'REST API платформы. Аутентификация — cookie-сессия + заголовок X-CSRF-Token для небезопасных методов.',
        },
        components: {
          securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: config.SESSION_COOKIE_NAME } },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }
  await app.register(websocket, { options: { maxPayload: 4096 } });

  registerSecurity(app, config);
  registerMetrics(app, config);
  const access = createAccess(app);

  await app.register(healthRoutes);
  const modules: Array<[string, RouteModule]> = [
    ['auth', authRoutes],
    ['tenant', tenantRoutes],
    ['settings', settingsRoutes],
    ['feed', feedRoutes],
    ['dashboard', dashboardRoutes],
    ['profiles', profileRoutes],
    ['sources', sourcesRoutes],
    ['workspace', workspaceRoutes],
    ['admin', adminRoutes],
    ['ws', realtimeRoutes],
  ];
  for (const [, mod] of modules) await app.register(async (scope) => mod(scope, access), { prefix: '/v1' });
  return app;
}
