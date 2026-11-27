CREATE TABLE IF NOT EXISTS spot_markets (
  market_id varchar(64) PRIMARY KEY,
  symbol varchar(24) NOT NULL,
  base_asset_code varchar(24) NOT NULL UNIQUE,
  quote_asset_code varchar(24) NOT NULL,
  base_reserve bigint NOT NULL CHECK (base_reserve > 0),
  quote_reserve bigint NOT NULL CHECK (quote_reserve > 0),
  base_decimals smallint NOT NULL DEFAULT 9 CHECK (base_decimals BETWEEN 0 AND 18),
  quote_decimals smallint NOT NULL DEFAULT 2 CHECK (quote_decimals BETWEEN 0 AND 18),
  fee_bps integer NOT NULL DEFAULT 50 CHECK (fee_bps BETWEEN 0 AND 9999),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spot_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  market_id varchar(64) NOT NULL REFERENCES spot_markets(market_id) ON DELETE RESTRICT,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  side varchar(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spot_trades_user_idempotency_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS spot_trades_user_created_idx ON spot_trades(user_id, created_at DESC);
INSERT INTO spot_markets
  (market_id, symbol, base_asset_code, quote_asset_code, base_reserve, quote_reserve, base_decimals, quote_decimals, fee_bps)
VALUES
  ('apex-demo', 'DEMO', 'APEX_DEMO', 'APEX_CREDIT', 1000000000000, 1000000000, 9, 2, 50)
ON CONFLICT (market_id) DO NOTHING;

DROP TRIGGER IF EXISTS spot_trades_immutable ON spot_trades;
CREATE TRIGGER spot_trades_immutable
BEFORE UPDATE OR DELETE ON spot_trades
FOR EACH ROW EXECUTE FUNCTION apex_reject_ledger_mutation();
