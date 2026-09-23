// ledger.ts — filtered, paginated, privacy-safe ledger access
import { Router, Request, Response } from "express";
import { AppError, fromMinor } from "./core";
import { query } from "./db";
import { requireAuth, requireKyc, ok, fail } from "./auth";

const router = Router();

// GET /api/ledger?from&to&type&currency&counterpartyPhone&before&limit
router.get("/ledger", requireAuth, requireKyc, async (req, res) => {
  try {
    const uid = (req as any).auth.uid;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const type = validType(req.query.type);
    const currency = validCcy(req.query.currency);
    const before = parseInt(String(req.query.before || ""), 10);
    const limit = Math.min(parseInt(String(req.query.limit || "30"), 10) || 30, 100);
    let counterpartyId: number | null = null;

    if (req.query.counterpartyPhone) {
      const phone = String(req.query.counterpartyPhone);
      if (!/^(056|059)[0-9]{7}$/.test(phone)) throw new AppError("VALIDATION_ERROR", "bad counterparty phone");
      const r = await query(`SELECT id FROM users WHERE phone = $1`, [phone]);
      counterpartyId = r.rows.length ? r.rows[0].id : -1; // -1 → no match → empty result
    }

    const where: string[] = ["w.user_id = $1"];
    const params: any[] = [uid];
    if (from) { params.push(from); where.push(`a.created_at >= $${params.length}::date`); }
    if (to)   { params.push(to); where.push(`a.created_at < ($${params.length}::date + 1)`); }
    if (type) { params.push(type); where.push(`a.tx_type = $${params.length}::tx_type`); }
    if (currency) { params.push(currency); where.push(`w.currency = $${params.length}::currency_code`); }
    if (counterpartyId !== null) { params.push(counterpartyId); where.push(`a.counterparty_user_id = $${params.length}`); }
    if (Number.isInteger(before) && before > 0) { params.push(before); where.push(`a.id < $${params.length}`); }

    const sql = `
      SELECT a.id, a.tx_uuid, a.direction, a.amount_minor, a.balance_before, a.balance_after,
             a.tx_type, a.applied_rate, a.created_at, w.currency,
             cp.full_name AS counterparty_name
      FROM audit_ledger a
      JOIN wallets w ON w.id = a.wallet_id
      LEFT JOIN users cp ON cp.id = a.counterparty_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.id DESC
      LIMIT ${limit + 1}`;

    const r = await query(sql, params);
    const hasMore = r.rows.length > limit;
    const rows = r.rows.slice(0, limit).map(mapRow);

    ok(res, { items: rows, nextCursor: hasMore ? r.rows[limit - 1].id : null, hasMore });
  } catch (e) { fail(res, e); }
});

function mapRow(a: any) {
  const sign = a.direction === "debit" ? -1 : 1;
  return {
    id: a.id,
    txUuid: a.tx_uuid,
    direction: a.direction,
    type: a.tx_type,
    currency: a.currency,
    amount: fromMinor(a.amount_minor, a.currency),
    amountMinor: a.amount_minor,
    signedAmount: (sign * a.amount_minor),
    balanceBefore: a.balance_before,
    balanceAfter: a.balance_after,
    counterparty: a.counterparty_name,
    appliedRate: a.applied_rate ? parseFloat(a.applied_rate) : null,
    occurredAt: a.created_at,
  };
}

function parseDate(v: any): string | null {
  if (!v) return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError("VALIDATION_ERROR", "date must be YYYY-MM-DD");
  return s;
}
function validType(v: any): string | null {
  if (!v) return null;
  const s = String(v);
  const okTypes = ["fakka_deposit", "qr_payment", "p2p_transfer", "fx_conversion"];
  if (!okTypes.includes(s)) throw new AppError("VALIDATION_ERROR", "bad tx type");
  return s;
}
function validCcy(v: any): string | null {
  if (!v) return null;
  const s = String(v).toUpperCase();
  if (!["ILS", "USD", "JOD"].includes(s)) throw new AppError("VALIDATION_ERROR", "bad currency");
  return s;
}

export default router;
