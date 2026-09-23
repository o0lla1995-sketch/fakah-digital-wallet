-- 06_functions.sql — atomic settlement & FX engine (PL/pgSQL)

-- minor-unit scale per currency
CREATE OR REPLACE FUNCTION fn_ccy_scale(p currency_code)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'JOD' THEN 1000
    WHEN 'USD' THEN  100
    WHEN 'ILS' THEN  100
  END
$$;

-- active FX rate (direct / inverse / cross via ILS pivot) + representative rate id
CREATE OR REPLACE FUNCTION fn_fx_rate(
  p_from    currency_code,
  p_to      currency_code,
  OUT rate    NUMERIC,
  OUT rate_id BIGINT
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_f NUMERIC;  v_t NUMERIC;  v_fid BIGINT;
BEGIN
  IF p_from = p_to THEN rate := 1; rate_id := NULL; RETURN; END IF;

  SELECT r.rate, r.id INTO rate, rate_id
  FROM exchange_rates r
  WHERE r.base_ccy = p_from AND r.quote_ccy = p_to AND r.is_active
  ORDER BY r.fetched_at DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  SELECT 1 / r.rate, r.id INTO rate, rate_id
  FROM exchange_rates r
  WHERE r.base_ccy = p_to AND r.quote_ccy = p_from AND r.is_active
  ORDER BY r.fetched_at DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  SELECT r.rate, r.id INTO v_f, v_fid
  FROM exchange_rates r
  WHERE r.base_ccy = p_from AND r.quote_ccy = 'ILS' AND r.is_active
  ORDER BY r.fetched_at DESC LIMIT 1;

  SELECT r.rate INTO v_t
  FROM exchange_rates r
  WHERE r.base_ccy = p_to AND r.quote_ccy = 'ILS' AND r.is_active
  ORDER BY r.fetched_at DESC LIMIT 1;

  IF v_f IS NULL OR v_t IS NULL THEN
    RAISE EXCEPTION 'NO_ACTIVE_RATE for % -> %', p_from, p_to;
  END IF;
  rate := v_f / v_t;  rate_id := v_fid;  RETURN;
END $$;

-- ensure the three wallets exist for a user (used on KYC approval)
CREATE OR REPLACE FUNCTION fn_ensure_wallets(p_user_id BIGINT)
RETURNS INTEGER LANGUAGE sql AS $$
  INSERT INTO wallets (user_id, currency)
  SELECT p_user_id, c FROM (VALUES ('ILS'::currency_code),
                                    ('USD'::currency_code),
                                    ('JOD'::currency_code)) AS t(c)
  ON CONFLICT (user_id, currency) DO NOTHING;
  SELECT 3;
$$;

-- ══════════ QR atomic settlement ══════════
CREATE OR REPLACE FUNCTION fn_settle_qr_transaction(
  p_payer_user_id BIGINT,
  p_token_hash    UUID,
  p_amount_minor  BIGINT,
  p_currency      currency_code
) RETURNS TABLE (
  out_tx_uuid       UUID,
  out_payer_balance BIGINT,
  out_payee_balance BIGINT,
  out_payee_user_id BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  v_qr           qr_tokens%ROWTYPE;
  v_payer_wallet BIGINT;
  v_payee_wallet BIGINT;
  v_payer        wallets%ROWTYPE;
  v_payee        wallets%ROWTYPE;
  v_tx           UUID := gen_random_uuid();
BEGIN
  -- (1) lock the QR row: single-use guard
  SELECT * INTO v_qr FROM qr_tokens
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QR_NOT_FOUND'; END IF;
  IF v_qr.used_at IS NOT NULL THEN RAISE EXCEPTION 'QR_ALREADY_USED'; END IF;
  IF v_qr.expires_at < now() THEN RAISE EXCEPTION 'QR_EXPIRED'; END IF;
  IF v_qr.amount_minor <> p_amount_minor OR v_qr.currency <> p_currency THEN
    RAISE EXCEPTION 'QR_PAYLOAD_MISMATCH';
  END IF;

  -- (2) resolve both wallets
  v_payee_wallet := v_qr.wallet_id;
  SELECT id INTO v_payer_wallet FROM wallets
  WHERE user_id = p_payer_user_id AND currency = p_currency;
  IF v_payer_wallet IS NULL THEN
    RAISE EXCEPTION 'PAYER_WALLET_MISSING for %', p_currency;
  END IF;
  IF v_payer_wallet = v_payee_wallet THEN
    RAISE EXCEPTION 'SELF_PAYMENT_FORBIDDEN';
  END IF;

  -- (3) lock both rows in ascending id order (deadlock prevention)
  IF v_payer_wallet < v_payee_wallet THEN
    SELECT * INTO v_payer FROM wallets WHERE id = v_payer_wallet FOR UPDATE;
    SELECT * INTO v_payee FROM wallets WHERE id = v_payee_wallet FOR UPDATE;
  ELSE
    SELECT * INTO v_payee FROM wallets WHERE id = v_payee_wallet FOR UPDATE;
    SELECT * INTO v_payer FROM wallets WHERE id = v_payer_wallet FOR UPDATE;
  END IF;

  -- (4) strict financial conditions
  IF (SELECT kyc_status FROM users WHERE id = v_payee.user_id) <> 'approved' THEN
    RAISE EXCEPTION 'PAYEE_NOT_VERIFIED';
  END IF;
  IF (SELECT kyc_status FROM users WHERE id = p_payer_user_id) <> 'approved' THEN
    RAISE EXCEPTION 'PAYER_NOT_VERIFIED';
  END IF;
  IF v_payer.balance_minor < p_amount_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: have %, need %',
      v_payer.balance_minor, p_amount_minor;
  END IF;

  -- (5) debit + credit with optimistic version bump
  UPDATE wallets
     SET balance_minor = balance_minor - p_amount_minor,
         version = version + 1, updated_at = now()
   WHERE id = v_payer_wallet;

  UPDATE wallets
     SET balance_minor = balance_minor + p_amount_minor,
         version = version + 1, updated_at = now()
   WHERE id = v_payee_wallet;

  -- (6) double-entry ledger records
  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor,
     balance_before, balance_after, counterparty_user_id, tx_type)
  VALUES
    (v_tx, v_payer_wallet, 'debit', p_amount_minor,
     v_payer.balance_minor, v_payer.balance_minor - p_amount_minor,
     v_payee.user_id, 'qr_payment');

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor,
     balance_before, balance_after, counterparty_user_id, tx_type)
  VALUES
    (v_tx, v_payee_wallet, 'credit', p_amount_minor,
     v_payee.balance_minor, v_payee.balance_minor + p_amount_minor,
     p_payer_user_id, 'qr_payment');

  -- (7) consume the token inside the same transaction
  UPDATE qr_tokens SET used_at = now() WHERE token_hash = p_token_hash;

  RETURN QUERY SELECT
    v_tx,
    v_payer.balance_minor - p_amount_minor,
    v_payee.balance_minor + p_amount_minor,
    v_payee.user_id;
END $$;

-- ══════════ internal FX conversion ══════════
CREATE OR REPLACE FUNCTION fn_convert_fx(
  p_user_id      BIGINT,
  p_from         currency_code,
  p_to           currency_code,
  p_amount_minor BIGINT
) RETURNS TABLE (
  out_tx_uuid      UUID,
  out_from_balance BIGINT,
  out_to_balance   BIGINT,
  out_credited     BIGINT,
  out_applied_rate NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_wf      wallets%ROWTYPE;
  v_wt      wallets%ROWTYPE;
  v_rate    NUMERIC;
  v_rid     BIGINT;
  v_target  BIGINT;
  v_tx      UUID := gen_random_uuid();
BEGIN
  IF p_from = p_to THEN RAISE EXCEPTION 'SAME_CURRENCY'; END IF;
  IF p_amount_minor <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  SELECT * INTO v_wf FROM wallets WHERE user_id = p_user_id AND currency = p_from;
  SELECT * INTO v_wt FROM wallets WHERE user_id = p_user_id AND currency = p_to;
  IF v_wf.id IS NULL OR v_wt.id IS NULL THEN RAISE EXCEPTION 'WALLETS_NOT_READY'; END IF;

  IF v_wf.id < v_wt.id THEN
    SELECT * INTO v_wf FROM wallets WHERE id = v_wf.id FOR UPDATE;
    SELECT * INTO v_wt FROM wallets WHERE id = v_wt.id FOR UPDATE;
  ELSE
    SELECT * INTO v_wt FROM wallets WHERE id = v_wt.id FOR UPDATE;
    SELECT * INTO v_wf FROM wallets WHERE id = v_wf.id FOR UPDATE;
  END IF;

  IF (SELECT kyc_status FROM users WHERE id = p_user_id) <> 'approved' THEN
    RAISE EXCEPTION 'USER_NOT_VERIFIED';
  END IF;
  IF v_wf.balance_minor < p_amount_minor THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;

  SELECT rate, rate_id INTO v_rate, v_rid FROM fn_fx_rate(p_from, p_to);

  v_target := ROUND(
    (p_amount_minor::NUMERIC / fn_ccy_scale(p_from)) * v_rate * fn_ccy_scale(p_to)
  )::BIGINT;
  IF v_target <= 0 THEN RAISE EXCEPTION 'ROUNDED_TO_ZERO'; END IF;

  UPDATE wallets SET balance_minor = balance_minor - p_amount_minor,
         version = version + 1, updated_at = now() WHERE id = v_wf.id;
  UPDATE wallets SET balance_minor = balance_minor + v_target,
         version = version + 1, updated_at = now() WHERE id = v_wt.id;

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, rate_id, applied_rate, tx_type)
  VALUES
    (v_tx, v_wf.id, 'debit', p_amount_minor, v_wf.balance_minor,
     v_wf.balance_minor - p_amount_minor, p_user_id, v_rid, v_rate, 'fx_conversion');

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, rate_id, applied_rate, tx_type)
  VALUES
    (v_tx, v_wt.id, 'credit', v_target, v_wt.balance_minor,
     v_wt.balance_minor + v_target, p_user_id, v_rid, v_rate, 'fx_conversion');

  RETURN QUERY SELECT v_tx,
    v_wf.balance_minor - p_amount_minor,
    v_wt.balance_minor + v_target,
    v_target, v_rate;
END $$;

-- ══════════ P2P transfer (same currency) ══════════
CREATE OR REPLACE FUNCTION fn_transfer_p2p(
  p_sender_user_id    BIGINT,
  p_recipient_user_id BIGINT,
  p_amount_minor      BIGINT,
  p_currency          currency_code
) RETURNS TABLE (
  out_tx_uuid          UUID,
  out_sender_balance   BIGINT,
  out_recipient_balance BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  v_ws wallets%ROWTYPE;
  v_wr wallets%ROWTYPE;
  v_tx UUID := gen_random_uuid();
BEGIN
  IF p_sender_user_id = p_recipient_user_id THEN RAISE EXCEPTION 'SELF_TRANSFER_FORBIDDEN'; END IF;
  IF p_amount_minor <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  SELECT * INTO v_ws FROM wallets
  WHERE user_id = p_sender_user_id AND currency = p_currency;
  SELECT * INTO v_wr FROM wallets
  WHERE user_id = p_recipient_user_id AND currency = p_currency;
  IF v_ws.id IS NULL OR v_wr.id IS NULL THEN RAISE EXCEPTION 'WALLETS_NOT_READY'; END IF;

  IF v_ws.id < v_wr.id THEN
    SELECT * INTO v_ws FROM wallets WHERE id = v_ws.id FOR UPDATE;
    SELECT * INTO v_wr FROM wallets WHERE id = v_wr.id FOR UPDATE;
  ELSE
    SELECT * INTO v_wr FROM wallets WHERE id = v_wr.id FOR UPDATE;
    SELECT * INTO v_ws FROM wallets WHERE id = v_ws.id FOR UPDATE;
  END IF;

  IF (SELECT kyc_status FROM users WHERE id = p_sender_user_id) <> 'approved'
     OR (SELECT kyc_status FROM users WHERE id = p_recipient_user_id) <> 'approved' THEN
    RAISE EXCEPTION 'PARTY_NOT_VERIFIED';
  END IF;
  IF v_ws.balance_minor < p_amount_minor THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;

  UPDATE wallets SET balance_minor = balance_minor - p_amount_minor,
         version = version + 1, updated_at = now() WHERE id = v_ws.id;
  UPDATE wallets SET balance_minor = balance_minor + p_amount_minor,
         version = version + 1, updated_at = now() WHERE id = v_wr.id;

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, tx_type)
  VALUES
    (v_tx, v_ws.id, 'debit', p_amount_minor, v_ws.balance_minor,
     v_ws.balance_minor - p_amount_minor, p_recipient_user_id, 'p2p_transfer');

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, tx_type)
  VALUES
    (v_tx, v_wr.id, 'credit', p_amount_minor, v_wr.balance_minor,
     v_wr.balance_minor + p_amount_minor, p_sender_user_id, 'p2p_transfer');

  RETURN QUERY SELECT v_tx,
    v_ws.balance_minor - p_amount_minor,
    v_wr.balance_minor + p_amount_minor;
END $$;

-- ══════════ digital fakka return (optional live FX) ══════════
CREATE OR REPLACE FUNCTION fn_send_fakka(
  p_sender_user_id    BIGINT,
  p_recipient_user_id BIGINT,
  p_amount_minor      BIGINT,
  p_from              currency_code,
  p_to                currency_code
) RETURNS TABLE (
  out_tx_uuid           UUID,
  out_sender_balance    BIGINT,
  out_recipient_balance BIGINT,
  out_credited          BIGINT,
  out_applied_rate      NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_ws     wallets%ROWTYPE;
  v_wr     wallets%ROWTYPE;
  v_rate   NUMERIC := NULL;
  v_rid    BIGINT  := NULL;
  v_credit BIGINT;
  v_tx     UUID := gen_random_uuid();
BEGIN
  IF p_sender_user_id = p_recipient_user_id THEN RAISE EXCEPTION 'SELF_TRANSFER_FORBIDDEN'; END IF;
  IF p_amount_minor <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  SELECT * INTO v_ws FROM wallets
  WHERE user_id = p_sender_user_id AND currency = p_from;
  SELECT * INTO v_wr FROM wallets
  WHERE user_id = p_recipient_user_id AND currency = p_to;
  IF v_ws.id IS NULL OR v_wr.id IS NULL THEN RAISE EXCEPTION 'WALLETS_NOT_READY'; END IF;

  IF v_ws.id < v_wr.id THEN
    SELECT * INTO v_ws FROM wallets WHERE id = v_ws.id FOR UPDATE;
    SELECT * INTO v_wr FROM wallets WHERE id = v_wr.id FOR UPDATE;
  ELSE
    SELECT * INTO v_wr FROM wallets WHERE id = v_wr.id FOR UPDATE;
    SELECT * INTO v_ws FROM wallets WHERE id = v_ws.id FOR UPDATE;
  END IF;

  IF (SELECT kyc_status FROM users WHERE id = p_sender_user_id) <> 'approved'
     OR (SELECT kyc_status FROM users WHERE id = p_recipient_user_id) <> 'approved' THEN
    RAISE EXCEPTION 'PARTY_NOT_VERIFIED';
  END IF;
  IF v_ws.balance_minor < p_amount_minor THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;

  IF p_from = p_to THEN
    v_credit := p_amount_minor;
  ELSE
    SELECT rate, rate_id INTO v_rate, v_rid FROM fn_fx_rate(p_from, p_to);
    v_credit := ROUND(
      (p_amount_minor::NUMERIC / fn_ccy_scale(p_from)) * v_rate * fn_ccy_scale(p_to)
    )::BIGINT;
    IF v_credit <= 0 THEN RAISE EXCEPTION 'ROUNDED_TO_ZERO'; END IF;
  END IF;

  UPDATE wallets SET balance_minor = balance_minor - p_amount_minor,
         version = version + 1, updated_at = now() WHERE id = v_ws.id;
  UPDATE wallets SET balance_minor = balance_minor + v_credit,
         version = version + 1, updated_at = now() WHERE id = v_wr.id;

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, rate_id, applied_rate, tx_type)
  VALUES
    (v_tx, v_ws.id, 'debit', p_amount_minor, v_ws.balance_minor,
     v_ws.balance_minor - p_amount_minor, p_recipient_user_id, v_rid, v_rate, 'fakka_deposit');

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, rate_id, applied_rate, tx_type)
  VALUES
    (v_tx, v_wr.id, 'credit', v_credit, v_wr.balance_minor,
     v_wr.balance_minor + v_credit, p_sender_user_id, v_rid, v_rate, 'fakka_deposit');

  RETURN QUERY SELECT v_tx,
    v_ws.balance_minor - p_amount_minor,
    v_wr.balance_minor + v_credit,
    v_credit, v_rate;
END $$;
