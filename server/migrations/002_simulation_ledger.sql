CREATE TABLE IF NOT EXISTS ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  account_code text NOT NULL,
  asset_code varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_code_nonempty CHECK (length(trim(account_code)) > 0),
  CONSTRAINT ledger_accounts_asset_nonempty CHECK (length(trim(asset_code)) > 0),
  CONSTRAINT ledger_accounts_id_asset_unique UNIQUE (id, asset_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_user_account_unique
  ON ledger_accounts (owner_user_id, asset_code)
  WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_system_account_unique
  ON ledger_accounts (account_code, asset_code)
  WHERE owner_user_id IS NULL;

CREATE TABLE IF NOT EXISTS ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  kind varchar(40) NOT NULL,
  asset_code varchar(24) NOT NULL,
  reference_type varchar(40),
  reference_id varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_journal_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT ledger_journal_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_starter_credit_once
  ON ledger_journals (user_id)
  WHERE kind = 'starter_credit';
CREATE INDEX IF NOT EXISTS ledger_journals_user_created_idx
  ON ledger_journals (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  asset_code varchar(24) NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entry_nonzero CHECK (amount_minor <> 0),
  CONSTRAINT ledger_entry_account_asset_fk
    FOREIGN KEY (account_id, asset_code)
    REFERENCES ledger_accounts(id, asset_code) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx ON ledger_entries (journal_id, id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, id);

CREATE TABLE IF NOT EXISTS ledger_events (
  sequence_id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type varchar(40) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_events_user_sequence_idx ON ledger_events (user_id, sequence_id);

CREATE OR REPLACE FUNCTION apex_reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger records are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_accounts_immutable ON ledger_accounts;
CREATE TRIGGER ledger_accounts_immutable
BEFORE UPDATE OR DELETE ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION apex_reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_journals_immutable ON ledger_journals;
CREATE TRIGGER ledger_journals_immutable
BEFORE UPDATE OR DELETE ON ledger_journals
FOR EACH ROW EXECUTE FUNCTION apex_reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION apex_reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_events_immutable ON ledger_events;
CREATE TRIGGER ledger_events_immutable
BEFORE UPDATE OR DELETE ON ledger_events
FOR EACH ROW EXECUTE FUNCTION apex_reject_ledger_mutation();

CREATE OR REPLACE FUNCTION apex_assert_ledger_journal_balanced() RETURNS trigger AS $$
DECLARE
  journal_total numeric;
  expected_asset text;
  distinct_assets integer;
  target_journal_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    target_journal_id := NEW.id;
  ELSE
    target_journal_id := NEW.journal_id;
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(DISTINCT asset_code)
    INTO journal_total, distinct_assets
    FROM ledger_entries
   WHERE journal_id = target_journal_id;
  SELECT asset_code INTO expected_asset FROM ledger_journals WHERE id = target_journal_id;
  IF journal_total <> 0 OR distinct_assets <> 1 OR EXISTS (
    SELECT 1 FROM ledger_entries WHERE journal_id = target_journal_id AND asset_code <> expected_asset
  ) THEN
    RAISE EXCEPTION 'ledger journal must balance in a single asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_journal_balanced ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_journal_nonempty_balanced ON ledger_journals;
CREATE CONSTRAINT TRIGGER ledger_journal_nonempty_balanced
AFTER INSERT ON ledger_journals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION apex_assert_ledger_journal_balanced();
CREATE CONSTRAINT TRIGGER ledger_journal_balanced
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION apex_assert_ledger_journal_balanced();
