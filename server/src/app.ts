import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { AppConfig } from './config.js';
import type { Pool } from 'pg';
import type { Cache } from './db/pool.js';
import { resolveSession } from './auth/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLedgerRoutes } from './routes/ledger.js';

export interface AppDependencies {
  config: AppConfig;
  db: Pool;
  redis: Cache;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.config.NODE_ENV !== 'test', trustProxy: deps.config.NODE_ENV === 'production' });
  app.decorateRequest('apexUser', null);
  await app.register(cookie);
  await app.register(cors, { origin: deps.config.APP_ORIGIN, credentials: true });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  app.get('/v1/health/live', async () => ({ status: 'ok', service: 'apex-api' }));
  app.get('/v1/health/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = { postgres: 'error', redis: 'error' };
    try { await deps.db.query('SELECT 1'); checks.postgres = 'ok'; } catch { /* keep dependency details private */ }
    try { await deps.redis.ping(); checks.redis = 'ok'; } catch { /* keep dependency details private */ }
    const ready = Object.values(checks).every(value => value === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded', checks });
  });

  await registerAuthRoutes(app, { db: deps.db, config: deps.config });
  await registerLedgerRoutes(app, { db: deps.db });

  app.get('/v1/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      request.apexUser = await resolveSession(request, deps.db);
      if (!request.apexUser) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }
  }, (socket, request) => {
    socket.send(JSON.stringify({ type: 'connected', userId: request.apexUser!.id }));
    socket.on('message', (raw: unknown) => {
      const message = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString() : '';
      if (message === 'ping') socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, 'request failed');
    if (reply.sent) return;
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' });
  });
  return app;
}