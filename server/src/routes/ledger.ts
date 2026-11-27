import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import {
  claimStarterCredits,
  getCreditBalance,
  getLedgerHistory,
  IdempotencyConflictError,
  StarterCreditAlreadyClaimedError,
  ledgerConstants
} from '../ledger/service.js';

const idempotencySchema = z.string().min(8).max(128);

export async function registerLedgerRoutes(app: FastifyInstance, deps: { db: Pool }) {
  app.get('/v1/ledger/balance', async (request, reply) => {
    const user = await resolveSession(request, deps.db);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const balanceMinor = await getCreditBalance(deps.db, user.id);
    return reply.send({ assetCode: ledgerConstants.assetCode, decimals: ledgerConstants.decimals, balanceMinor });
  });

  app.get('/v1/ledger/journals', async (request, reply) => {
    const user = await resolveSession(request, deps.db);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(10_000).default(0)
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'INVALID_PAGINATION' });
    const journals = await getLedgerHistory(deps.db, user.id, query.data.limit, query.data.offset);
    return reply.send({ journals });
  });

  app.post('/v1/ledger/starter-credit', async (request, reply) => {
    const user = await resolveSession(request, deps.db);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const rawKey = request.headers['idempotency-key'];
    const parsedKey = idempotencySchema.safeParse(rawKey);
    if (!parsedKey.success) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–128 characters).' });
    }
    try {
      const result = await claimStarterCredits(deps.db, user.id, parsedKey.data);
      return reply.code(result.replayed ? 200 : 201).send({
        journalId: result.journalId,
        assetCode: ledgerConstants.assetCode,
        decimals: ledgerConstants.decimals,
        amountMinor: ledgerConstants.starterCreditMinor,
        balanceMinor: result.balanceMinor,
        replayed: result.replayed,
        note: 'Virtual simulator credits only. No cryptocurrency was deposited or transferred.'
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      if (error instanceof StarterCreditAlreadyClaimedError) return reply.code(409).send({ error: 'STARTER_CREDIT_ALREADY_CLAIMED' });
      throw error;
    }
  });
}
