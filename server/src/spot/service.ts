import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const MAX_AMOUNT = 9_000_000_000_000_000_000n;
const BPS = 10_000n;

export class SpotMarketNotFoundError extends Error {}
export class SpotMarketPausedError extends Error {}
export class SpotInsufficientBalanceError extends Error {}
export class SpotSlippageError extends Error {}
export class SpotIdempotencyConflictError extends Error {}
export class SpotInvalidOrderError extends Error {}

type Side = 'BUY' | 'SELL';
type MarketRow = {
  market_id: string; symbol: string; base_asset_code: string; quote_asset_code: string;
  base_reserve: string; quote_reserve: string; base_decimals: number; quote_decimals: number;
  fee_bps: number; status: string;
};

function hashRequest(userId: string, marketId: string, side: Side, amount: bigint, maxSlippageBps: number) {
  return createHash('sha256').update([userId, marketId, side, amount.toString(), String(maxSlippageBps)].join(':')).digest('hex');
}
function parsePositiveInteger(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new SpotInvalidOrderError(label + ' must be a positive integer string.');
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_AMOUNT) throw new SpotInvalidOrderError(label + ' is outside the supported range.');
  return parsed;
}
function ceilDiv(n: bigint, d: bigint) { return (n + d - 1n) / d; }

function calculateQuote(market: MarketRow, side: Side, amount: bigint) {
  const base = BigInt(market.base_reserve), quote = BigInt(market.quote_reserve);
  const feeBps = BigInt(market.fee_bps), k = base * quote;
  if (side === 'BUY') {
    const fee = amount * feeBps / BPS;
    const net = amount - fee;
    const nextQuote = quote + net;
    const nextBase = k / nextQuote;
    const baseOut = base - nextBase;
    if (baseOut <= 0n || nextBase <= 0n) throw new SpotInvalidOrderError('Order size is too small or pool inventory is exhausted.');
    const effectiveSlippageBps = (amount * base * BPS / (baseOut * quote)) > BPS
      ? Number(amount * base * BPS / (baseOut * quote) - BPS) : 0;
    return { side, amountInMinor: amount.toString(), amountOutMinor: baseOut.toString(),
      feeMinor: fee.toString(), effectiveSlippageBps, nextBaseReserve: nextBase, nextQuoteReserve: nextQuote };
  }
  const nextBase = base + amount;
  const nextQuote = ceilDiv(k, nextBase);
  const gross = quote - nextQuote;
  const fee = gross * feeBps / BPS;
  const quoteOut = gross - fee;
  if (quoteOut <= 0n || nextQuote <= 0n) throw new SpotInvalidOrderError('Order size is too small or pool quote liquidity is exhausted.');
  const ratio = quoteOut * base * BPS / (amount * quote);
  const effectiveSlippageBps = ratio < BPS ? Number(BPS - ratio) : 0;
  return { side, amountInMinor: amount.toString(), amountOutMinor: quoteOut.toString(),
    feeMinor: fee.toString(), effectiveSlippageBps, nextBaseReserve: nextBase, nextQuoteReserve: nextQuote };
}

async function ensureAccounts(client: PoolClient, userId: string, assets: string[]) {
  for (const asset of [...new Set(assets)].sort()) {
    const accountCode = asset === 'APEX_CREDIT' ? 'USER_CREDITS' : 'USER_ASSET';
    await client.query(
      `INSERT INTO ledger_accounts (owner_user_id, account_code, asset_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_id, asset_code) WHERE owner_user_id IS NOT NULL DO NOTHING`,
      [userId, accountCode, asset]
    );
    await client.query(
      `INSERT INTO ledger_accounts (owner_user_id, account_code, asset_code)
       VALUES (NULL, 'SPOT_CLEARING', $1)
       ON CONFLICT (account_code, asset_code) WHERE owner_user_id IS NULL DO NOTHING`,
      [asset]
    );
  }
}
async function balanceMinor(client: PoolClient, userId: string, asset: string) {
  const result = await client.query(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS balance
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_user_id = $1 AND a.asset_code = $2`,
    [userId, asset]
  );
  return BigInt(String(result.rows[0]?.balance ?? '0'));
}

export async function listSpotMarkets(pool: Pool) {
  const result = await pool.query(
    `SELECT market_id AS "marketId", symbol, base_asset_code AS "baseAssetCode",
            quote_asset_code AS "quoteAssetCode", base_reserve::text AS "baseReserveMinor",
            quote_reserve::text AS "quoteReserveMinor", base_decimals AS "baseDecimals",
            quote_decimals AS "quoteDecimals", fee_bps AS "feeBps", status,
            (quote_reserve::numeric / base_reserve::numeric) AS "priceQuotePerBase"
       FROM spot_markets ORDER BY market_id`
  );
  return result.rows;
}

export async function quoteSpotTrade(pool: Pool, marketId: string, side: Side, amountMinor: string, maxSlippageBps = 1500) {
  const amount = parsePositiveInteger(amountMinor, 'amountMinor');
  const found = await pool.query('SELECT * FROM spot_markets WHERE market_id = $1', [marketId]);
  const market = found.rows[0] as MarketRow | undefined;
  if (!market) throw new SpotMarketNotFoundError('Market not found.');
  if (market.status !== 'ACTIVE') throw new SpotMarketPausedError('Market is not active.');
  const quote = calculateQuote(market, side, amount);
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 5000 ||
      quote.effectiveSlippageBps > maxSlippageBps) throw new SpotSlippageError('Slippage tolerance exceeded.');
  return { marketId, symbol: market.symbol, ...quote, feeBps: market.fee_bps,
    note: 'Indicative simulator quote. Reserves may change before execution.' };
}

export async function executeSpotTrade(
  pool: Pool, userId: string, marketId: string, side: Side,
  amountMinorInput: string, maxSlippageBps: number, idempotencyKey: string
) {
  const amount = parsePositiveInteger(amountMinorInput, 'amountMinor');
  if (!['BUY', 'SELL'].includes(side)) throw new SpotInvalidOrderError('side must be BUY or SELL.');
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 5000) {
    throw new SpotInvalidOrderError('maxSlippageBps must be between 0 and 5000.');
  }
  const requestHash = hashRequest(userId, marketId, side, amount, maxSlippageBps);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM spot_markets WHERE market_id = $1 FOR UPDATE', [marketId]);
    const market = found.rows[0] as MarketRow | undefined;
    if (!market) throw new SpotMarketNotFoundError('Market not found.');
    if (market.status !== 'ACTIVE') throw new SpotMarketPausedError('Market is not active.');

    const prior = await client.query(
      'SELECT id, request_hash, result FROM spot_trades WHERE user_id = $1 AND idempotency_key = $2',
      [userId, idempotencyKey]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new SpotIdempotencyConflictError('Idempotency key conflict.');
      await client.query('COMMIT');
      return { ...(prior.rows[0].result as Record<string, unknown>), tradeId: prior.rows[0].id, replayed: true };
    }

    const quote = calculateQuote(market, side, amount);
    if (quote.effectiveSlippageBps > maxSlippageBps) throw new SpotSlippageError('Slippage tolerance exceeded.');
    const baseAsset = market.base_asset_code, quoteAsset = market.quote_asset_code;
    await ensureAccounts(client, userId, [baseAsset, quoteAsset]);
    const accountRows = await client.query(
      `SELECT id, owner_user_id, asset_code, account_code FROM ledger_accounts
        WHERE (owner_user_id = $1 AND asset_code = ANY($2::varchar[]))
           OR (owner_user_id IS NULL AND account_code = 'SPOT_CLEARING' AND asset_code = ANY($2::varchar[]))
        ORDER BY id FOR UPDATE`,
      [userId, [baseAsset, quoteAsset]]
    );
    const userAccounts = new Map<string, string>();
    const clearingAccounts = new Map<string, string>();
    for (const row of accountRows.rows) {
      if (row.owner_user_id) userAccounts.set(row.asset_code, row.id);
      else clearingAccounts.set(row.asset_code, row.id);
    }
    if (userAccounts.size !== 2 || clearingAccounts.size !== 2) throw new Error('Spot ledger account initialization failed.');

    const debitAsset = side === 'BUY' ? quoteAsset : baseAsset;
    const creditAsset = side === 'BUY' ? baseAsset : quoteAsset;
    const debitAmount = amount;
    const creditAmount = BigInt(quote.amountOutMinor);
    if (await balanceMinor(client, userId, debitAsset) < debitAmount) {
      throw new SpotInsufficientBalanceError('Insufficient virtual asset balance.');
    }

    const tradeInsert = await client.query(
      `INSERT INTO spot_trades (user_id, market_id, idempotency_key, request_hash, side, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [userId, marketId, idempotencyKey, requestHash, side, amount.toString()]
    );
    if (!tradeInsert.rows[0]) {
      const raced = await client.query('SELECT id, request_hash, result FROM spot_trades WHERE user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey]);
      if (!raced.rows[0] || raced.rows[0].request_hash !== requestHash) throw new SpotIdempotencyConflictError('Idempotency key conflict.');
      await client.query('COMMIT');
      return { ...(raced.rows[0].result as Record<string, unknown>), tradeId: raced.rows[0].id, replayed: true };
    }
    const tradeId = tradeInsert.rows[0].id as string;
    const journalIds: string[] = [];
    for (const asset of [debitAsset, creditAsset]) {
      const journalKey = 'spot:' + tradeId + (asset === debitAsset ? ':debit' : ':credit');
      const journal = await client.query(
        `INSERT INTO ledger_journals
          (user_id, idempotency_key, request_hash, kind, asset_code, reference_type, reference_id, metadata)
         VALUES ($1, $2, $3, $4, $5, 'spot_trade', $6, $7::jsonb) RETURNING id`,
        [userId, journalKey, requestHash, side === 'BUY' ? 'spot_buy' : 'spot_sell', asset, tradeId,
          JSON.stringify({ marketId, side, amountMinor: amount.toString(), tradeId })]
      );
      journalIds.push(journal.rows[0].id as string);
      const userAccount = userAccounts.get(asset)!, clearingAccount = clearingAccounts.get(asset)!;
      const userDelta = asset === debitAsset ? -debitAmount : creditAmount;
      const clearingDelta = -userDelta;
      await client.query(
        `INSERT INTO ledger_entries (journal_id, account_id, asset_code, amount_minor)
         VALUES ($1, $2, $3, $4), ($1, $5, $3, $6)`,
        [journal.rows[0].id, userAccount, asset, userDelta.toString(), clearingAccount, clearingDelta.toString()]
      );
    }

    await client.query(
      `UPDATE spot_markets SET base_reserve = $2, quote_reserve = $3, updated_at = now() WHERE market_id = $1`,
      [marketId, quote.nextBaseReserve.toString(), quote.nextQuoteReserve.toString()]
    );
    const newDebitBalance = await balanceMinor(client, userId, debitAsset);
    const newCreditBalance = await balanceMinor(client, userId, creditAsset);
    const result = {
      tradeId, marketId, symbol: market.symbol, side,
      amountInMinor: amount.toString(), amountOutMinor: creditAmount.toString(),
      debitAsset, creditAsset, feeMinor: quote.feeMinor,
      effectiveSlippageBps: quote.effectiveSlippageBps, maxSlippageBps,
      baseReserveAfter: quote.nextBaseReserve.toString(), quoteReserveAfter: quote.nextQuoteReserve.toString(),
      balanceAfter: { [debitAsset]: newDebitBalance.toString(), [creditAsset]: newCreditBalance.toString() },
      journalIds, simulated: true, replayed: false,
      note: 'Simulated trade only. No blockchain transaction or external DEX data was changed.'
    };
    await client.query('UPDATE spot_trades SET result = $2::jsonb WHERE id = $1', [tradeId, JSON.stringify(result)]);
    await client.query(
      `INSERT INTO ledger_events (journal_id, user_id, event_type, payload)
       VALUES ($1, $2, 'spot_trade_executed', $3::jsonb)`,
      [journalIds[0], userId, JSON.stringify(result)]
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
