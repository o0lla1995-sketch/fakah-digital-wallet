// wallets.ts — balances, rates, FX refresher, device FCM registration
import { Router, Request, Response } from "express";
import { z } from "zod";
import { AppError, fromMinor } from "./core";
import { query } from "./db";
import { requireAuth, requireKyc, ok, fail } from "./auth";

const router = Router();

// GET /api/wallets — the three balances
router.get("/wallets", requireAuth, requireKyc, async (req, res) => {
  try {
    const r = await query(
      `SELECT w.id, w.currency, w.balance_minor, w.updated_at, u.kyc_status
       FROM wallets w JOIN users u ON u.id = w.user_id
       WHERE w.user_id = $1 ORDER BY w.currency`, [(req as any).auth.uid]
    );
    ok(res, r.rows.map(w => ({
      currency: w.currency,
      balanceMinor: w.balance_minor,
      balance: fromMinor(w.balance_minor, w.currency),
      updatedAt: w.updated_at,
    })));
  } catch (e) { fail(res, e); }
});

// GET /api/rates — active rates (cross-computed vs ILS)
router.get("/rates", requireAuth, async (_req, res) => {
  try {
    const r = await query(`SELECT base_ccy, quote_ccy, rate, fetched_at
                           FROM exchange_rates WHERE is_active
                           ORDER BY base_ccy, quote_ccy, fetched_at DESC`);
    // latest per pair
    const seen = new Map<string, any>();
    for (const row of r.rows) {
      const k = `${row.base_ccy}/${row.quote_ccy}`;
      if (!seen.has(k)) seen.set(k, row);
    }
    const out: any = {};
    for (const [k, v] of seen) {
      out[k] = { rate: parseFloat(v.rate), fetchedAt: v.fetched_at };
    }
    ok(res, { base: "ILS", pairs: out, supported: ["ILS", "USD", "JOD"] });
  } catch (e) { fail(res, e); }
});

// POST /api/devices/fcm — register/refresh device token
const fcmSchema = z.object({ token: z.string().min(20).max(255), deviceInfo: z.string().max(160).optional() });
router.post("/devices/fcm", requireAuth, async (req, res) => {
  try {
    const parsed = fcmSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const { token, deviceInfo } = parsed.data;
    await query(
      `INSERT INTO fcm_tokens (user_id, token, device_info, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (token) DO UPDATE
         SET user_id = $1, device_info = $3, active = true, updated_at = now()`,
      [(req as any).auth.uid, token, deviceInfo || null]
    );
    ok(res, { registered: true });
  } catch (e) { fail(res, e); }
});

// ── FX rates refresher (scheduled, fail-safe) ──
export async function refreshRates(): Promise<void> {
  const pairs: Array<[string, string, number]> = [];
  try {
    // provider: open.er-api.com (free, base ILS) — quote per unit
    const url = `https://${"open.er-api.com"}/v6/latest/ILS`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`provider http ${resp.status}`);
    const data: any = await resp.json();
    if (data.result !== "success" || !data.rates) throw new Error("provider bad payload");
    const usdIls = 1 / Number(data.rates.USD); // ILS per 1 USD
    const jodIls = 1 / Number(data.rates.JOD); // ILS per 1 JOD
    if (!isFinite(usdIls) || usdIls <= 0 || !isFinite(jodIls) || jodIls <= 0) {
      throw new Error("provider invalid rates");
    }
    pairs.push(["USD", "ILS", usdIls]);
    pairs.push(["JOD", "ILS", jodIls]);
  } catch (e: any) {
    console.warn("[rates] provider failed:", e.message);
    return;
  }

  try {
    await query(`UPDATE exchange_rates SET is_active = false WHERE is_active`);
    for (const [base, quote, rate] of pairs) {
      await query(
        `INSERT INTO exchange_rates (base_ccy, quote_ccy, rate, is_active, fetched_at)
         VALUES ($1, $2, $3, true, now())`,
        [base, quote, rate.toString()]
      );
    }
    console.log(`[rates] refreshed: ${pairs.map(p => `${p[0]}/ILS=${p[2].toFixed(4)}`).join(" ")}`);
  } catch (e: any) {
    console.error("[rates] persist failed:", e.message);
  }
}

export function startRatesScheduler(): void {
  refreshRates().then(async () => {
    // seed fallback rates if none exist yet (provider may be unreachable at boot)
    const r = await query(`SELECT count(*)::int AS n FROM exchange_rates WHERE is_active`);
    if (r.rows[0].n === 0) {
      await query(`UPDATE exchange_rates SET is_active = false WHERE is_active`);
      await query(`INSERT INTO exchange_rates (base_ccy, quote_ccy, rate, is_active, fetched_at)
                   VALUES ('USD','ILS',3.65,true,now()), ('JOD','ILS',5.15,true,now())`);
      console.warn("[rates] seeded fallback static rates (USD/ILS=3.65, JOD/ILS=5.15)");
    }
  });
  setInterval(refreshRates, 15 * 60 * 1000).unref();
}

export default router;
