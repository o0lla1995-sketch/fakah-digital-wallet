-- 02_kyc_wallets.sql — KYC documents + multi-currency wallets
CREATE TABLE IF NOT EXISTS kyc_docs (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type     kyc_doc_type NOT NULL,
  storage_key  VARCHAR(200) NOT NULL,
  status       kyc_status   NOT NULL DEFAULT 'pending',
  reviewed_by  BIGINT       REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ux_kyc_user_doc UNIQUE (user_id, doc_type)
);

CREATE TABLE IF NOT EXISTS wallets (
  id            BIGSERIAL  PRIMARY KEY,
  user_id       BIGINT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency      currency_code NOT NULL,
  balance_minor BIGINT     NOT NULL DEFAULT 0,
  version       INTEGER    NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_wallet_user_ccy UNIQUE (user_id, currency),
  CONSTRAINT wallets_no_negative CHECK (balance_minor >= 0)
);

CREATE INDEX IF NOT EXISTS ix_wallets_user ON wallets (user_id);
