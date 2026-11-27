import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import {
  executeSpotTrade, listSpotMarkets, quoteSpotTrade,
  SpotIdempotencyConflictError, SpotInsufficientBalanceError,
  SpotInvalidOrderError, SpotMarketNotFoundError, SpotMarketPausedError, SpotSlippageError
} from '../spot/service.js';

const tradeSchema = z.object({
  marketId: z.string().min(1).max(64),
  side: z.enum(['BUY', 'SELL']),
  amountMinor: z.string().regex(/^\d+$/).max(19),
  maxSlippageBps: z.number().int().min(0).max(5000).default(1500)
});
function mapError(error: unknown, reply: FastifyReply) {
  if (error instanceof SpotMarketNotFoundError) return reply.code(404).send({ error: 'MARKET_NOT_FOUND' });
  if (error instanceof SpotMarketPausedError) return reply.code(409).send({ error: 'MARKET_PAUSED' });
  if (error instanceof SpotInsufficientBalanceError) return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE' });
  if (error instanceof SpotSlippageError) return reply.code(409).send({ error: 'SLIPPAGE_EXCEEDED' });
  if (error instanceof SpotIdempotencyConflictError) return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
  if (error instanceof SpotInvalidOrderError) return reply.code(400).send({ error: 'INVALID_ORDER', message: error.message });
  throw error;
}

export async function registerSpotRoutes(app: FastifyInstance, deps: { db: Pool }) {
  app.get('/v1/spot/markets', async (_request, reply) => reply.send({ markets: await listSpotMarkets(deps.db) }));
  app.post('/v1/spot/quote', async (request, reply) => {
    const parsed = tradeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_ORDER' });
    try {
      const quote = await quoteSpotTrade(deps.db, parsed.data.marketId, parsed.data.side, parsed.data.amountMinor, parsed.data.maxSlippageBps);
      return reply.send(quote);
    } catch (error) { return mapError(error, reply); }
  });
  app.post('/v1/spot/trades', async (request, reply) => {
    const user = await resolveSession(request, deps.db);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const parsed = tradeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_ORDER' });
    const rawKey = request.headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.length < 8 || rawKey.length > 120) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    try {
      const result = await executeSpotTrade(deps.db, user.id, parsed.data.marketId, parsed.data.side,
        parsed.data.amountMinor, parsed.data.maxSlippageBps, rawKey);
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { return mapError(error, reply); }
  });
}
