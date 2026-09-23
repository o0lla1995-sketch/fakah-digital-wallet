-- 03_rates_qr.sql — exchange rates + single-use QR tokens
CREATE TABLE IF NOT EXISTS exchange_rates (
  id         BIGSERIAL   PRIMARY KEY,
  base_ccy   currency_code NOT NULL,
  quote_ccy  currency_code NOT NULL,
  rate       NUMERIC(24,18) NOT NULL,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_rates_pair UNIQUE (base_ccy, quote_ccy, fetched_at),
  CONSTRAINT rates_positive CHECK (rate > 0)
);
CREATE INDEX IF NOT EXISTS ix_rates_active ON exchange_rates (base_ccy, quote_ccy)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS qr_tokens (
  id           BIGSERIAL   PRIMARY KEY,
  token_hash   UUID        NOT NULL,
  wallet_id    BIGINT      NOT NULL
               REFERENCES wallets(id) ON DELETE CASCADE,
  amount_minor BIGINT      NOT NULL,
  currency     currency_code NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_qr_hash UNIQUE (token_hash),
  CONSTRAINT qr_positive_amount CHECK (amount_minor > 0)
);
CREATE INDEX IF NOT EXISTS ix_qr_expiry ON qr_tokens (expires_at);
