import type { FastifyRequest } from 'fastify';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import { hashSessionToken } from './crypto.js';

export const SESSION_COOKIE = 'apex_session';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    apexUser: AuthUser | null;
  }
}

export async function resolveSession(request: FastifyRequest, db: Database): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const result = await db.query(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.created_at AS "createdAt"
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashSessionToken(token)]
  );
  return result.rows[0] ?? null;
}

export function setSessionCookie(reply: { setCookie: (...args: any[]) => unknown }, token: string, config: AppConfig) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60
  });
}

export function clearSessionCookie(reply: { clearCookie: (...args: any[]) => unknown }) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}