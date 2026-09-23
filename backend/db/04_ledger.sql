-- 04_ledger.sql — immutable audit ledger (3 protection layers)
CREATE TABLE IF NOT EXISTS audit_ledger (
  id                  BIGSERIAL  PRIMARY KEY,
  tx_uuid             UUID       NOT NULL,
  wallet_id           BIGINT     NOT NULL REFERENCES wallets(id),
  direction           tx_direction NOT NULL,
  amount_minor        BIGINT     NOT NULL,
  balance_before      BIGINT     NOT NULL,
  balance_after       BIGINT     NOT NULL,
  counterparty_user_id BIGINT    REFERENCES users(id),
  rate_id             BIGINT     REFERENCES exchange_rates(id),
  applied_rate        NUMERIC(24,18),
  tx_type             tx_type    NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_tx_side ON audit_ledger (tx_uuid, direction);
CREATE INDEX IF NOT EXISTS ix_ledger_wallet_time ON audit_ledger (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_type        ON audit_ledger (tx_type);
CREATE INDEX IF NOT EXISTS ix_ledger_counter     ON audit_ledger (counterparty_user_id);
CREATE INDEX IF NOT EXISTS ix_ledger_wallet_txid ON audit_ledger (wallet_id, id DESC);

-- layer 1: revoke modification privileges
REVOKE UPDATE, DELETE ON audit_ledger FROM PUBLIC;

-- layer 2: rejecting trigger
CREATE OR REPLACE FUNCTION fn_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'AUDIT_LEDGER append-only: % forbidden on id=%',
    TG_OP, OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_ledger_no_change ON audit_ledger;
CREATE TRIGGER trg_ledger_no_change
BEFORE UPDATE OR DELETE ON audit_ledger
FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable();
