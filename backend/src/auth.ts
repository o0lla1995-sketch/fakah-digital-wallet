// auth.ts — registration + KYC upload, login, refresh, me, admin review
import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { config, AppError, hashPassword, verifyPassword, signAccessToken, signRefreshToken,
         verifyRefreshToken, verifyAccessToken, AccessClaims, sha256Hex, randomHex,
         toMinor, fromMinor } from "./core";
import { query, tx } from "./db";
import { notifyKycDecision, notifySecurity } from "./notify";

const router = Router();
const adminRouter = Router();

// ── multer: KYC docs storage ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    cb(null, config.uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      return cb(new AppError("VALIDATION_ERROR", "only jpg/png/webp images allowed"), "");
    }
    cb(null, `${randomHex(24)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024, files: 3 },
});

// ── validation schemas ──
const nameRe = /^[\u0600-\u06FFa-zA-Z\s'.]{3,120}$/; // Arabic or Latin letters
const registerSchema = z.object({
  fullName: z.string().regex(nameRe, "full name must match official ID"),
  nationalId: z.string().regex(/^[0-9]{9}$/, "national id must be exactly 9 digits"),
  phone: z.string().regex(/^(056|059)[0-9]{7}$/, "phone must start with 056 or 059"),
  password: z.string().min(8, "password min 8 chars").regex(/[a-zA-Z]/, "needs letters").regex(/[0-9]/, "needs digits"),
});
const loginSchema = z.object({ phone: z.string(), password: z.string() });

function ok(res: Response, data: any) { res.json({ success: true, data }); }
function fail(res: Response, err: any) {
  const appErr = err instanceof AppError ? err : new AppError("INTERNAL", String(err?.message || err), 500);
  res.status(appErr.httpStatus).json({
    success: false,
    error: { code: appErr.code, message: appErr.message, httpStatus: appErr.httpStatus },
  });
}

// ── POST /api/auth/register (multipart: id_front, id_back, selfie) ──
router.post("/register", upload.fields([
  { name: "id_front", maxCount: 1 },
  { name: "id_back", maxCount: 1 },
  { name: "selfie", maxCount: 1 },
]), async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const { fullName, nationalId, phone, password } = parsed.data;

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const need = ["id_front", "id_back", "selfie"];
    for (const f of need) {
      if (!files || !files[f] || files[f].length === 0) {
        throw new AppError("VALIDATION_ERROR", `missing kyc file: ${f}`);
      }
    }

    const passwordHash = await hashPassword(password);
    const ffiles = files as Record<string, Express.Multer.File[]>;
    const user = await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO users (full_name, national_id, phone, password_hash, kyc_status, role)
         VALUES ($1, $2, $3, $4, 'pending', 'user') RETURNING id, full_name, phone, kyc_status`,
        [fullName.trim(), nationalId, phone, passwordHash]
      );
      const u = ins.rows[0];
      for (const f of need) {
        const file = ffiles[f][0];
        await c.query(
          `INSERT INTO kyc_docs (user_id, doc_type, storage_key)
           VALUES ($1, $2, $3) ON CONFLICT (user_id, doc_type) DO NOTHING`,
          [u.id, f, file.filename]
        );
      }
      return u;
    });

    ok(res, { userId: user.id, kycStatus: user.kyc_status, message: "registered — pending verification" });
  } catch (e) { fail(res, e); }
});

// ── POST /api/auth/login ──
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
router.post("/login", async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "phone and password required");
    const { phone, password } = parsed.data;

    const r = await query(
      `SELECT id, password_hash, kyc_status, role, failed_attempts, locked_until, full_name
       FROM users WHERE phone = $1`, [phone]
    );
    if (r.rows.length === 0) throw new AppError("INVALID_CREDENTIALS", "wrong phone or password");
    const u = r.rows[0];

    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
      throw new AppError("ACCOUNT_LOCKED", `account locked, try again in ${mins} minutes`);
    }

    const valid = await verifyPassword(u.password_hash, password);
    if (!valid) {
      const attempts = u.failed_attempts + 1;
      const lock = attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3`,
        [lock ? 0 : attempts, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null, u.id]
      );
      if (lock) {
        await notifySecurity(u.id, "تنبيه أمني", `تم قفل حسابك مؤقتاً بعد ${MAX_ATTEMPTS} محاولات دخول فاشلة`);
      }
      throw new AppError("INVALID_CREDENTIALS", "wrong phone or password");
    }

    await query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    const tokens = await issueTokens(u.id, u.role, u.kyc_status, req.headers["user-agent"]);
    ok(res, { ...tokens, kycStatus: u.kyc_status, fullName: u.full_name, role: u.role });
  } catch (e) { fail(res, e); }
});

// ── token issuance ──
async function issueTokens(uid: number, role: string, kyc: string, userAgent?: string) {
  const jti = crypto.randomUUID();
  const refresh = signRefreshToken(uid, jti);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [uid, sha256Hex(refresh), (userAgent || "").slice(0, 190)]
  );
  return {
    accessToken: signAccessToken({ uid, role: role as "user" | "admin", kyc }),
    refreshToken: refresh,
    tokenType: "Bearer",
    expiresInSec: 900,
  };
}

// ── POST /api/auth/refresh ──
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) throw new AppError("VALIDATION_ERROR", "refreshToken required");
    let claims: { uid: number; jti: string };
    try { claims = verifyRefreshToken(refreshToken); }
    catch { throw new AppError("INVALID_CREDENTIALS", "invalid refresh token"); }

    const db = await query(
      `SELECT rt.revoked_at, rt.expires_at, u.role, u.kyc_status FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.user_id = $2`, [sha256Hex(refreshToken), claims.uid]
    );
    if (db.rows.length === 0) throw new AppError("INVALID_CREDENTIALS", "refresh token not recognized");
    const row = db.rows[0];
    if (row.revoked_at || new Date(row.expires_at) < new Date()) {
      throw new AppError("INVALID_CREDENTIALS", "refresh token revoked or expired");
    }
    // rotate: revoke old, issue new pair
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256Hex(refreshToken)]);
    const tokens = await issueTokens(claims.uid, row.role, row.kyc_status, req.headers["user-agent"]);
    ok(res, tokens);
  } catch (e) { fail(res, e); }
});

// ── POST /api/auth/logout ──
router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND token_hash = $2`,
        [(req as any).auth.uid, sha256Hex(refreshToken)]);
    }
    ok(res, { loggedOut: true });
  } catch (e) { fail(res, e); }
});

// ── GET /api/me ──
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT id, full_name, phone, national_id, kyc_status, role, created_at FROM users WHERE id = $1`,
      [(req as any).auth.uid]
    );
    if (r.rows.length === 0) throw new AppError("USER_NOT_FOUND", "user missing");
    ok(res, r.rows[0]);
  } catch (e) { fail(res, e); }
});

// ── auth middleware ──
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new AppError("INVALID_CREDENTIALS", "missing bearer token"));
  try {
    const claims: AccessClaims = verifyAccessToken(token);
    (req as any).auth = claims;
    next();
  } catch {
    next(new AppError("INVALID_CREDENTIALS", "invalid or expired token"));
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if ((req as any).auth?.role !== "admin") return next(new AppError("FORBIDDEN", "admin only"));
  next();
}

export async function requireKyc(req: Request, _res: Response, next: NextFunction) {
  try {
    // check LIVE status (not the JWT claim) → approval takes effect instantly
    const r = await query<{ kyc_status: string }>(
      `SELECT kyc_status FROM users WHERE id = $1`, [(req as any).auth.uid]
    );
    const status = r.rows[0]?.kyc_status || "pending";
    if (status === "approved") return next();
    if (status === "rejected") return next(new AppError("KYC_REJECTED", "verification was rejected"));
    return next(new AppError("KYC_PENDING", "account not verified yet"));
  } catch (e: any) {
    next(new AppError("KYC_PENDING", "account not verified yet"));
  }
}

export function requireBiometric(req: Request, _res: Response, next: NextFunction) {
  if (req.headers["x-biometric-confirmed"] !== "true" && (req.body?.biometricConfirmed !== true)) {
    return next(new AppError("BIOMETRIC_REQUIRED", "biometric confirmation header required", 403));
  }
  next();
}

// ── admin: GET /api/admin/kyc/pending ──
adminRouter.get("/admin/kyc/pending", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await query(
      `SELECT u.id, u.full_name, u.phone, u.national_id, u.created_at,
              json_agg(json_build_object('docType', k.doc_type, 'storageKey', k.storage_key)) AS docs
       FROM users u JOIN kyc_docs k ON k.user_id = u.id
       WHERE u.kyc_status = 'pending'
       GROUP BY u.id ORDER BY u.created_at ASC LIMIT 100`
    );
    ok(res, r.rows);
  } catch (e) { fail(res, e); }
});

// ── admin: serve KYC document image ──
adminRouter.get("/admin/kyc/doc/:key", requireAuth, requireAdmin, async (req, res) => {
  try {
    const key = String(req.params.key || "").replace(/[^a-z0-9_.-]/gi, "");
    const f = path.join(config.uploadsDir, key);
    if (!fs.existsSync(f)) throw new AppError("USER_NOT_FOUND", "document not found");
    res.sendFile(f);
  } catch (e) { fail(res, e); }
});

// ── admin: POST /api/admin/kyc/:userId/decision ──
adminRouter.post("/admin/kyc/:userId/decision", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { approve, reason } = req.body || {};
    if (typeof approve !== "boolean") throw new AppError("VALIDATION_ERROR", "approve (boolean) required");
    const adminId = (req as any).auth.uid;

    await tx(async (c) => {
      const upd = await c.query(
        `UPDATE users SET kyc_status = $1, updated_at = now() WHERE id = $2 AND kyc_status = 'pending'
         RETURNING id`, [approve ? "approved" : "rejected", userId]
      );
      if (upd.rows.length === 0) throw new AppError("USER_NOT_FOUND", "user not pending or missing");
      await c.query(
        `UPDATE kyc_docs SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE user_id = $3`,
        [approve ? "approved" : "rejected", adminId, userId]
      );
      if (approve) {
        await c.query(`SELECT fn_ensure_wallets($1)`, [userId]);
      }
      await c.query(
        `INSERT INTO admin_audit (admin_id, action, target_user, details)
         VALUES ($1, $2, $3, $4)`,
        [adminId, approve ? "kyc_approve" : "kyc_reject", userId, JSON.stringify({ reason: reason || null })]
      );
    });

    await notifyKycDecision(userId, approve, reason);
    ok(res, { userId, approved: approve });
  } catch (e) { fail(res, e); }
});

// ── admin: POST /api/admin/credit — system credit to a user wallet (audited) ──
const creditSchema = z.object({
  phone: z.string().regex(/^(056|059)[0-9]{7}$/),
  currency: z.enum(["ILS", "USD", "JOD"]),
  amount: z.union([z.string(), z.number()]),
});
adminRouter.post("/admin/credit", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = creditSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const { phone, currency } = parsed.data;
    const amountMinor = toMinor(parsed.data.amount as any, currency);
    const adminId = (req as any).auth.uid;

    const target = await query(`SELECT id, full_name FROM users WHERE phone = $1`, [phone]);
    if (target.rows.length === 0) throw new AppError("USER_NOT_FOUND", "target user not found");
    const targetId = target.rows[0].id;

    const result = await tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM fn_system_credit($1, $2, $3, $4)`,
        [adminId, targetId, currency, amountMinor]
      );
      await c.query(
        `INSERT INTO admin_audit (admin_id, action, target_user, details)
         VALUES ($1, 'system_credit', $2, $3)`,
        [adminId, targetId, JSON.stringify({ currency, amountMinor })]
      );
      return r.rows[0];
    });

    ok(res, {
      txUuid: result.out_tx_uuid,
      phone, currency,
      credited: `${fromMinor(amountMinor, currency)} ${currency}`,
      newBalanceMinor: result.out_new_balance,
    });
  } catch (e) { fail(res, e); }
});

export { fail, ok, adminRouter };
export default router;
