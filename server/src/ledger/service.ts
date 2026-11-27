import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const ASSET_CODE = 'APEX_CREDIT';
const STARTER_CREDIT_MINOR = 1_000_000n; // 10,000.00 virtual credits; two decimal places.

export class IdempotencyConflictError extends Error {
  constructor() { super('Idempotency key was already used with a different request.'); }
}
export class StarterCreditAlreadyClaimedError extends Error {
  constructor() { super('Starter credits have already been claimed.'); }
}

function requestHash(userId: string, kind: string, amountMinor: bigint): string {
  return createHash('sha256').update([userId, kind, ASSET_CODE, amountMinor.toString()].join(':')).digest('hex');
}

async function readBalance(client: PoolClient, userId: string): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS balance_minor
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_user_id = $1 AND a.asset_code = $2 AND a.account_code = 'USER_CREDITS'`,
    [userId, ASSET_CODE]
  );
  return String(result.rows[0]?.balance_minor ?? '0');
}

export async function getCreditBalance(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS balance_minor
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_user_id = $1 AND a.asset_code = $2 AND a.account_code = 'USER_CREDITS'`,
    [userId, ASSET_CODE]
  );
  return String(result.rows[0]?.balance_minor ?? '0');
}

export async function claimStarterCredits(pool: Pool, userId: string, idempotencyKey: string) {
  const hash = requestHash(userId, 'starter_credit', STARTER_CREDIT_MINOR);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ledger_accounts (owner_user_id, account_code, asset_code)
       VALUES ($1, 'USER_CREDITS', $2)
       ON CONFLICT (owner_user_id, asset_code) WHERE owner_user_id IS NOT NULL DO NOTHING`,
      [userId, ASSET_CODE]
    );
    await client.query(
      `INSERT INTO ledger_accounts (owner_user_id, account_code, asset_code)
       VALUES (NULL, 'VIRTUAL_CREDITS_ISSUED', $1)
       ON CONFLICT (account_code, asset_code) WHERE owner_user_id IS NULL DO NOTHING`,
      [ASSET_CODE]
    );

    const created = await client.query(
      `INSERT INTO ledger_journals
         (user_id, idempotency_key, request_hash, kind, asset_code, reference_type, reference_id, metadata)
       VALUES ($1, $2, $3, 'starter_credit', $4, 'account', $1, $5::jsonb)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [userId, idempotencyKey, hash, ASSET_CODE, JSON.stringify({ amountMinor: STARTER_CREDIT_MINOR.toString(), source: 'virtual_starter_grant' })]
    );

    if (created.rowCount === 0) {
      const previous = await client.query(
        'SELECT id, request_hash FROM ledger_journals WHERE user_id = $1 AND idempotency_key = $2',
        [userId, idempotencyKey]
      );
      if (!previous.rows[0] || previous.rows[0].request_hash !== hash) throw new IdempotencyConflictError();
      const balanceMinor = await readBalance(client, userId);
      await client.query('COMMIT');
      return { journalId: previous.rows[0].id as string, balanceMinor, replayed: true };
    }

    const journalId = created.rows[0].id as string;
    const accounts = await client.query(
      `SELECT id, account_code
         FROM ledger_accounts
        WHERE asset_code = $1
          AND ((owner_user_id = $2 AND account_code = 'USER_CREDITS')
            OR (owner_user_id IS NULL AND account_code = 'VIRTUAL_CREDITS_ISSUED'))
        ORDER BY id
        FOR UPDATE`,
      [ASSET_CODE, userId]
    );
    const userAccount = accounts.rows.find(row => row.account_code === 'USER_CREDITS');
    const issuanceAccount = accounts.rows.find(row => row.account_code === 'VIRTUAL_CREDITS_ISSUED');
    if (!userAccount || !issuanceAccount) throw new Error('Ledger account initialization failed.');

    await client.query(
      `INSERT INTO ledger_entries (journal_id, account_id, asset_code, amount_minor)
       VALUES ($1, $2, $3, $4), ($1, $5, $3, $6)`,
      [journalId, userAccount.id, ASSET_CODE, STARTER_CREDIT_MINOR.toString(), issuanceAccount.id, (-STARTER_CREDIT_MINOR).toString()]
    );
    await client.query(
      `INSERT INTO ledger_events (journal_id, user_id, event_type, payload)
       VALUES ($1, $2, 'starter_credit_granted', $3::jsonb)`,
      [journalId, userId, JSON.stringify({ amountMinor: STARTER_CREDIT_MINOR.toString(), assetCode: ASSET_CODE })]
    );
    const balanceMinor = await readBalance(client, userId);
    await client.query('COMMIT');
    return { journalId, balanceMinor, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      const existing = await pool.query(
        `SELECT id FROM ledger_journals WHERE user_id = $1 AND kind = 'starter_credit'`,
        [userId]
      ).catch(() => ({ rows: [] as Array<{ id: string }> }));
      if (existing.rows[0]) throw new StarterCreditAlreadyClaimedError();
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getLedgerHistory(pool: Pool, userId: string, limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT j.id, j.kind, j.asset_code AS "assetCode", j.reference_type AS "referenceType",
            j.reference_id AS "referenceId", j.metadata, j.created_at AS "createdAt",
            COALESCE(json_agg(json_build_object(
              'accountCode', a.account_code,
              'amountMinor', e.amount_minor::text,
              'assetCode', e.asset_code
            ) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS entries
       FROM ledger_journals j
       LEFT JOIN ledger_entries e ON e.journal_id = j.id
       LEFT JOIN ledger_accounts a ON a.id = e.account_id
      WHERE j.user_id = $1
      GROUP BY j.id
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
}

export const ledgerConstants = { assetCode: ASSET_CODE, starterCreditMinor: STARTER_CREDIT_MINOR.toString(), decimals: 2 };
