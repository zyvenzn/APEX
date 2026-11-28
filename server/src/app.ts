import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { AppConfig } from './config.js';
import type { Pool } from 'pg';
import { resolveSession } from './auth/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerSpotRoutes } from './routes/spot.js';
import { checkMigrationReadiness } from './db/migration-readiness.js';

export interface AppDependencies {
  config: AppConfig;
  db: Pool;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.config.NODE_ENV !== 'test', trustProxy: deps.config.NODE_ENV === 'production' });
  app.decorateRequest('apexUser', null);
  const expectedOrigin = new URL(deps.config.APP_ORIGIN).origin;
  await app.register(cookie);
  await app.register(cors, { origin: expectedOrigin, credentials: true });
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    let requestOrigin: string | null = null;
    try {
      if (origin) requestOrigin = new URL(origin).origin;
      else if (referer) requestOrigin = new URL(referer).origin;
    } catch { requestOrigin = null; }
    if ((origin || referer) && requestOrigin !== expectedOrigin) {
      return reply.code(403).send({ error: 'CSRF_ORIGIN_REJECTED' });
    }
    if (deps.config.NODE_ENV === 'production' && !requestOrigin) {
      return reply.code(403).send({ error: 'CSRF_ORIGIN_REQUIRED' });
    }
  });
  await app.register(websocket);

  app.get('/v1/health/live', async () => ({ status: 'ok', service: 'apex-api' }));
  app.get('/v1/health/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = { postgres: 'error', migrations: 'error' };
    try {
      await deps.db.query('SELECT 1');
      checks.postgres = 'ok';
      const migrationState = await checkMigrationReadiness(deps.db);
      checks.migrations = migrationState.ready ? 'ok' : 'error';
    } catch { /* keep dependency and schema details private */ }
    const ready = Object.values(checks).every(value => value === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded', checks });
  });

  await registerAuthRoutes(app, { db: deps.db, config: deps.config });
  await registerLedgerRoutes(app, { db: deps.db });
  await registerSpotRoutes(app, { db: deps.db });

  app.get('/v1/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      let websocketOrigin: string | null = null;
      try { websocketOrigin = request.headers.origin ? new URL(request.headers.origin).origin : null; }
      catch { websocketOrigin = null; }
      if (websocketOrigin !== expectedOrigin) return reply.code(403).send({ error: 'CSRF_ORIGIN_REJECTED' });
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
    if (reply.sent) return;
    const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 429) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' });
    }
    app.log.error({ err: error }, 'request failed');
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'REQUEST_REJECTED', message: 'The request could not be accepted.' });
    }
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' });
  });
  return app;
}