-- 07_system_credit.sql — admin-operated system credit (bootstrap/ops funding)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'tx_type' AND e.enumlabel = 'system_credit') THEN
    ALTER TYPE tx_type ADD VALUE 'system_credit';
  END IF;
END $$;

-- credit a user wallet without debiting anyone (closed-loop system mint, admin-audited)
CREATE OR REPLACE FUNCTION fn_system_credit(
  p_admin_id    BIGINT,
  p_user_id     BIGINT,
  p_currency    currency_code,
  p_amount_minor BIGINT
) RETURNS TABLE (
  out_tx_uuid    UUID,
  out_new_balance BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  v_w     wallets%ROWTYPE;
  v_tx    UUID := gen_random_uuid();
  v_admin kyc_status;
BEGIN
  SELECT kyc_status INTO v_admin FROM users WHERE id = p_admin_id;
  IF v_admin IS NULL OR v_admin <> 'approved' THEN
    RAISE EXCEPTION 'ADMIN_NOT_VERIFIED';
  END IF;
  IF p_amount_minor <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  SELECT * INTO v_w FROM wallets
  WHERE user_id = p_user_id AND currency = p_currency;
  IF v_w.id IS NULL THEN RAISE EXCEPTION 'WALLETS_NOT_READY'; END IF;

  SELECT * INTO v_w FROM wallets WHERE id = v_w.id FOR UPDATE;

  UPDATE wallets SET balance_minor = balance_minor + p_amount_minor,
         version = version + 1, updated_at = now() WHERE id = v_w.id;

  INSERT INTO audit_ledger
    (tx_uuid, wallet_id, direction, amount_minor, balance_before, balance_after,
     counterparty_user_id, tx_type)
  VALUES
    (v_tx, v_w.id, 'credit', p_amount_minor, v_w.balance_minor,
     v_w.balance_minor + p_amount_minor, p_admin_id, 'system_credit');

  RETURN QUERY SELECT v_tx, v_w.balance_minor + p_amount_minor;
END $$;
