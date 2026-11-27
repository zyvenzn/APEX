import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from '../auth/crypto.js';
import { clearSessionCookie, resolveSession, setSessionCookie, SESSION_COOKIE } from '../auth/session.js';

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(40)
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
});

async function issueSession(db: Database, userId: string, config: AppConfig) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashSessionToken(token), userId, expiresAt]
  );
  return token;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: { db: Database; config: AppConfig }) {
  const { db, config } = deps;

  app.post('/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', message: 'Email, password (minimum 12 characters), and display name are required.' });
    const email = parsed.data.email.toLowerCase();
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const created = await db.query(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name AS "displayName", created_at AS "createdAt"',
        [email, passwordHash, parsed.data.displayName]
      );
      const user = created.rows[0];
      const token = await issueSession(db, user.id, config);
      setSessionCookie(reply, token, config);
      return reply.code(201).send({ user });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'EMAIL_EXISTS', message: 'An account with this email already exists.' });
      throw error;
    }
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', message: 'A valid email and password are required.' });
    const result = await db.query(
      'SELECT id, email, display_name AS "displayName", created_at AS "createdAt", password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [parsed.data.email]
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    }
    const token = await issueSession(db, user.id, config);
    setSessionCookie(reply, token, config);
    delete user.password_hash;
    return reply.send({ user });
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const user = await resolveSession(request, db);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return reply.send({ user });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}