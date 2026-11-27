-- Make system-origin journals possible so seeded pool inventory is represented in the same
-- immutable, double-entry ledger as user balances and fees.
ALTER TABLE ledger_journals ALTER COLUMN user_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_system_journal_idempotency_unique
  ON ledger_journals (idempotency_key) WHERE user_id IS NULL;

INSERT INTO ledger_accounts (owner_user_id, account_code, asset_code)
VALUES
  (NULL, 'SPOT_POOL:apex-demo', 'APEX_DEMO'),
  (NULL, 'SPOT_POOL:apex-demo', 'APEX_CREDIT'),
  (NULL, 'SPOT_FEE_REVENUE:apex-demo', 'APEX_CREDIT'),
  (NULL, 'VIRTUAL_ASSET_ISSUANCE', 'APEX_DEMO'),
  (NULL, 'VIRTUAL_ASSET_ISSUANCE', 'APEX_CREDIT')
ON CONFLICT (account_code, asset_code) WHERE owner_user_id IS NULL DO NOTHING;

DO $$
DECLARE
  seed record;
  journal_id uuid;
  pool_account uuid;
  issuance_account uuid;
BEGIN
  FOR seed IN
    SELECT market_id, base_asset_code AS asset_code, base_reserve::text AS reserve_minor
      FROM spot_markets WHERE market_id = 'apex-demo'
    UNION ALL
    SELECT market_id, quote_asset_code, quote_reserve::text
      FROM spot_markets WHERE market_id = 'apex-demo'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM ledger_journals
       WHERE user_id IS NULL
         AND idempotency_key = 'spot-opening:' || seed.market_id || ':' || seed.asset_code
    ) THEN
      INSERT INTO ledger_journals
        (user_id, idempotency_key, request_hash, kind, asset_code, reference_type, reference_id, metadata)
      VALUES
        (NULL, 'spot-opening:' || seed.market_id || ':' || seed.asset_code,
         repeat('0', 64), 'spot_pool_opening', seed.asset_code, 'spot_market', seed.market_id,
         jsonb_build_object('reserveMinor', seed.reserve_minor, 'source', 'simulator_seed'))
      RETURNING id INTO journal_id;

      SELECT id INTO pool_account FROM ledger_accounts
       WHERE owner_user_id IS NULL AND account_code = 'SPOT_POOL:' || seed.market_id
         AND asset_code = seed.asset_code;
      SELECT id INTO issuance_account FROM ledger_accounts
       WHERE owner_user_id IS NULL AND account_code = 'VIRTUAL_ASSET_ISSUANCE'
         AND asset_code = seed.asset_code;

      INSERT INTO ledger_entries (journal_id, account_id, asset_code, amount_minor)
      VALUES
        (journal_id, pool_account, seed.asset_code, seed.reserve_minor::bigint),
        (journal_id, issuance_account, seed.asset_code, -seed.reserve_minor::bigint);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS ledger_system_asset_account_idx
  ON ledger_accounts (account_code, asset_code) WHERE owner_user_id IS NULL;
