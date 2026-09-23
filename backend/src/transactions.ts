// transactions.ts — QR payload creation + atomic execution of qr/p2p/fx/fakka
import { Router, Request, Response } from "express";
import { z } from "zod";
import { AppError, config, hmacHex, toMinor, fromMinor, CCY_SCALE } from "./core";
import { query, tx } from "./db";
import { requireAuth, requireKyc, requireBiometric, ok, fail } from "./auth";
import { notifySettlement, SettlementNotice } from "./notify";

const router = Router();

// ═══════ POST /api/qr — create signed single-use payload ═══════
const qrSchema = z.object({
  amount: z.union([z.string(), z.number()]).refine(v => parseFloat(String(v)) > 0, "amount must be > 0"),
  currency: z.enum(["ILS", "USD", "JOD"]),
});
router.post("/qr", requireAuth, requireKyc, async (req, res) => {
  try {
    const parsed = qrSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const amountMinor = toMinor(parsed.data.amount as any, parsed.data.currency);
    if (amountMinor <= 0) throw new AppError("INVALID_AMOUNT", "amount too small for currency");

    const uid = (req as any).auth.uid;
    const wallet = await query(
      `SELECT id FROM wallets WHERE user_id = $1 AND currency = $2`,
      [uid, parsed.data.currency]
    );
    if (wallet.rows.length === 0) throw new AppError("WALLETS_NOT_READY", "wallet missing");
    const walletId = wallet.rows[0].id;

    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.qrTtlSeconds * 1000);

    await query(
      `INSERT INTO qr_tokens (token_hash, wallet_id, amount_minor, currency, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [nonce, walletId, amountMinor, parsed.data.currency, expiresAt]
    );

    // payload: v1.<wallet_id>.<amount_minor>.<CCY>.<exp_epoch>.<nonce>.<hmac>
    const core = `v1|${walletId}|${amountMinor}|${parsed.data.currency}|${Math.floor(expiresAt.getTime() / 1000)}|${nonce}`;
    const sig = hmacHex(core);
    const payload = `v1.${walletId}.${amountMinor}.${parsed.data.currency}.${Math.floor(expiresAt.getTime() / 1000)}.${nonce}.${sig}`;

    ok(res, {
      payload,
      expiresInSec: config.qrTtlSeconds,
      amountMinor,
      currency: parsed.data.currency,
    });
  } catch (e) { fail(res, e); }
});

// ── payload verification (signature + freshness; DB checks happen atomically) ──
function verifyPayload(payload: string) {
  const parts = payload.trim().split(".");
  if (parts.length !== 7 || parts[0] !== "v1") {
    throw new AppError("QR_PAYLOAD_MISMATCH", "malformed payload");
  }
  const [v, walletId, amount, ccy, exp, nonce, sig] = parts;
  const core = `v1|${walletId}|${amount}|${ccy}|${exp}|${nonce}`;
  const expected = hmacHex(core);
  if (sig !== expected) throw new AppError("QR_PAYLOAD_MISMATCH", "bad signature");
  if (parseInt(exp, 10) * 1000 < Date.now() - 5000) throw new AppError("QR_EXPIRED", "payload expired");
  if (!CCY_SCALE[ccy]) throw new AppError("QR_PAYLOAD_MISMATCH", "bad currency");
  const amountMinor = parseInt(amount, 10);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new AppError("QR_PAYLOAD_MISMATCH", "bad amount");
  return { walletId: parseInt(walletId, 10), amountMinor, currency: ccy, nonce };
}

// ═══════ POST /api/qr/preview — pre-execution look-up (shows payee before confirm) ═══════
router.post("/qr/preview", requireAuth, requireKyc, async (req, res) => {
  try {
    const { payload } = req.body || {};
    if (!payload || typeof payload !== "string") throw new AppError("VALIDATION_ERROR", "payload required");
    const v = verifyPayload(payload);

    const r = await query(
      `SELECT u.full_name, u.kyc_status, q.used_at, q.expires_at, q.amount_minor, q.currency
       FROM qr_tokens q
       JOIN wallets w ON w.id = q.wallet_id
       JOIN users u ON u.id = w.user_id
       WHERE q.token_hash = $1::uuid`, [v.nonce]
    );
    if (r.rows.length === 0) throw new AppError("QR_NOT_FOUND", "code not recognized");
    const row = r.rows[0];
    if (row.used_at) throw new AppError("QR_ALREADY_USED", "code already consumed");
    if (new Date(row.expires_at) < new Date()) throw new AppError("QR_EXPIRED", "code expired");
    if (row.kyc_status !== "approved") throw new AppError("PARTY_NOT_VERIFIED", "payee not verified");
    if (parseInt(row.amount_minor, 10) !== v.amountMinor || row.currency !== v.currency) {
      throw new AppError("QR_PAYLOAD_MISMATCH", "payload does not match issued code");
    }

    ok(res, {
      payeeName: row.full_name,
      amountMinor: row.amount_minor,
      amount: `${fromMinor(row.amount_minor, row.currency)} ${row.currency}`,
      currency: row.currency,
      expiresAt: row.expires_at,
      expiresInSec: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    });
  } catch (e) { fail(res, e); }
});

// ═══════ POST /api/transactions/qr — execute scanned QR atomically ═══════
router.post("/transactions/qr", requireAuth, requireKyc, requireBiometric, async (req, res) => {
  try {
    const { payload } = req.body || {};
    if (!payload || typeof payload !== "string") throw new AppError("VALIDATION_ERROR", "payload required");
    const v = verifyPayload(payload);
    const payerId = (req as any).auth.uid;

    const result = await tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM fn_settle_qr_transaction($1, $2::uuid, $3, $4)`,
        [payerId, v.nonce, v.amountMinor, v.currency]
      );
      return r.rows[0];
    });

    const names = await query(
      `SELECT id, full_name FROM users WHERE id IN ($1, $2)`,
      [payerId, result.out_payee_user_id]
    );
    const nameOf = (id: number) => names.rows.find(n => n.id === id)?.full_name || "—";

    const notice: SettlementNotice = {
      txUuid: result.out_tx_uuid,
      payer: { userId: payerId, name: nameOf(payerId), balanceMinor: result.out_payer_balance, ccy: v.currency },
      payee: { userId: result.out_payee_user_id, name: nameOf(result.out_payee_user_id), balanceMinor: result.out_payee_balance, ccy: v.currency },
      amountMinor: v.amountMinor,
      currency: v.currency,
      amountText: `${fromMinor(v.amountMinor, v.currency)} ${v.currency}`,
      txType: "qr_payment",
    };
    await notifySettlement(notice);

    ok(res, {
      txUuid: result.out_tx_uuid,
      amount: notice.amountText,
      counterparty: notice.payee.name,
      newBalanceMinor: result.out_payer_balance,
      currency: v.currency,
      occurredAt: new Date().toISOString(),
    });
  } catch (e) { fail(res, e); }
});

// ═══════ POST /api/transactions/p2p ═══════
const p2pSchema = z.object({
  phone: z.string().regex(/^(056|059)[0-9]{7}$/),
  amount: z.union([z.string(), z.number()]).refine(v => parseFloat(String(v)) > 0),
  currency: z.enum(["ILS", "USD", "JOD"]),
  note: z.string().max(140).optional(),
});
router.post("/transactions/p2p", requireAuth, requireKyc, requireBiometric, async (req, res) => {
  try {
    const parsed = p2pSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const { phone, currency, note } = parsed.data;
    const amountMinor = toMinor(parsed.data.amount as any, currency);
    const senderId = (req as any).auth.uid;

    const recipient = await query(`SELECT id, full_name, kyc_status FROM users WHERE phone = $1`, [phone]);
    if (recipient.rows.length === 0) throw new AppError("USER_NOT_FOUND", "recipient not found");
    const rcpt = recipient.rows[0];
    if (rcpt.kyc_status !== "approved") throw new AppError("PARTY_NOT_VERIFIED", "recipient not verified");

    const result = await tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM fn_transfer_p2p($1, $2, $3, $4)`,
        [senderId, rcpt.id, amountMinor, currency]
      );
      return r.rows[0];
    });

    const sender = await query(`SELECT full_name FROM users WHERE id = $1`, [senderId]);
    const notice: SettlementNotice = {
      txUuid: result.out_tx_uuid,
      payer: { userId: senderId, name: sender.rows[0].full_name, balanceMinor: result.out_sender_balance, ccy: currency },
      payee: { userId: rcpt.id, name: rcpt.full_name, balanceMinor: result.out_recipient_balance, ccy: currency },
      amountMinor, currency,
      amountText: `${fromMinor(amountMinor, currency)} ${currency}`,
      txType: "p2p_transfer",
    };
    await notifySettlement(notice);
    ok(res, {
      txUuid: result.out_tx_uuid, amount: notice.amountText,
      counterparty: rcpt.full_name, note: note || null,
      newBalanceMinor: result.out_sender_balance, currency,
    });
  } catch (e) { fail(res, e); }
});

// ═══════ POST /api/transactions/fx ═══════
const fxSchema = z.object({
  from: z.enum(["ILS", "USD", "JOD"]),
  to: z.enum(["ILS", "USD", "JOD"]),
  amount: z.union([z.string(), z.number()]).refine(v => parseFloat(String(v)) > 0),
});
router.post("/transactions/fx", requireAuth, requireKyc, requireBiometric, async (req, res) => {
  try {
    const parsed = fxSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    if (parsed.data.from === parsed.data.to) throw new AppError("SAME_CURRENCY", "from and to must differ");
    const uid = (req as any).auth.uid;
    const amountMinor = toMinor(parsed.data.amount as any, parsed.data.from);

    const result = await tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM fn_convert_fx($1, $2, $3, $4)`,
        [uid, parsed.data.from, parsed.data.to, amountMinor]
      );
      return r.rows[0];
    });

    ok(res, {
      txUuid: result.out_tx_uuid,
      debited: `${fromMinor(amountMinor, parsed.data.from)} ${parsed.data.from}`,
      credited: `${fromMinor(result.out_credited, parsed.data.to)} ${parsed.data.to}`,
      appliedRate: parseFloat(result.out_applied_rate),
      newFromBalanceMinor: result.out_from_balance,
      newToBalanceMinor: result.out_to_balance,
    });
  } catch (e) { fail(res, e); }
});

// ═══════ POST /api/transactions/fakka — merchant returns digital change ═══════
const fakkaSchema = z.object({
  phone: z.string().regex(/^(056|059)[0-9]{7}$/),
  amount: z.union([z.string(), z.number()]).refine(v => parseFloat(String(v)) > 0),
  from: z.enum(["ILS", "USD", "JOD"]),
  to: z.enum(["ILS", "USD", "JOD"]),
});
router.post("/transactions/fakka", requireAuth, requireKyc, requireBiometric, async (req, res) => {
  try {
    const parsed = fakkaSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const senderId = (req as any).auth.uid;
    const amountMinor = toMinor(parsed.data.amount as any, parsed.data.from);

    const recipient = await query(`SELECT id, full_name, kyc_status FROM users WHERE phone = $1`, [parsed.data.phone]);
    if (recipient.rows.length === 0) throw new AppError("USER_NOT_FOUND", "customer not found");
    const rcpt = recipient.rows[0];
    if (rcpt.kyc_status !== "approved") throw new AppError("PARTY_NOT_VERIFIED", "customer not verified");

    const result = await tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM fn_send_fakka($1, $2, $3, $4, $5)`,
        [senderId, rcpt.id, amountMinor, parsed.data.from, parsed.data.to]
      );
      return r.rows[0];
    });

    const sender = await query(`SELECT full_name FROM users WHERE id = $1`, [senderId]);
    const notice: SettlementNotice = {
      txUuid: result.out_tx_uuid,
      payer: { userId: senderId, name: sender.rows[0].full_name, balanceMinor: result.out_sender_balance, ccy: parsed.data.from },
      payee: { userId: rcpt.id, name: rcpt.full_name, balanceMinor: result.out_recipient_balance, ccy: parsed.data.to },
      amountMinor, currency: parsed.data.from,
      amountText: `${fromMinor(result.out_credited, parsed.data.to)} ${parsed.data.to}`,
      txType: "fakka_deposit",
    };
    await notifySettlement(notice);

    ok(res, {
      txUuid: result.out_tx_uuid,
      sent: `${fromMinor(amountMinor, parsed.data.from)} ${parsed.data.from}`,
      customerReceived: `${fromMinor(result.out_credited, parsed.data.to)} ${parsed.data.to}`,
      appliedRate: result.out_applied_rate ? parseFloat(result.out_applied_rate) : null,
      counterparty: rcpt.full_name,
      newBalanceMinor: result.out_sender_balance,
    });
  } catch (e) { fail(res, e); }
});

import crypto from "crypto";
export default router;
