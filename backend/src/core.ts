// core.ts — configuration, errors, security primitives
import path from "path";
import * as fs from "fs";

function reqEnv(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  databaseUrl: reqEnv("DATABASE_URL", "postgres://fakah:fakah@localhost:5432/fakah"),
  jwtSecret: reqEnv("JWT_SECRET", "dev-jwt-secret-change-me-32bytes-min-len!!"),
  jwtRefreshSecret: reqEnv("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me-32bytes!!"),
  qrHmacSecret: reqEnv("QR_HMAC_SECRET", "dev-qr-hmac-secret-change-me-32bytes!!"),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  qrTtlSeconds: 60,
  firebaseServiceAccountB64: process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "",
  fxApiKey: process.env.FX_RATES_API_KEY || "",
  fxProvider: process.env.FX_PROVIDER || "open.er-api.com",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  uploadsDir: path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "uploads"),
  statementsDir: path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "statements"),
  fontsDir: path.join(process.cwd(), "assets", "fonts"),
  adminPhone: process.env.ADMIN_PHONE || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminNationalId: process.env.ADMIN_NATIONAL_ID || "000000000",
  adminFullName: process.env.ADMIN_FULL_NAME || "System Administrator",
  nodeEnv: process.env.NODE_ENV || "development",
};

export function ensureDirs(): void {
  for (const d of [config.dataDir, config.uploadsDir, config.statementsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Error model (codes from the study, Table 6) ──
export class AppError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus ?? httpForCode(code);
  }
}
function httpForCode(code: string): number {
  switch (code) {
    case "INVALID_CREDENTIALS": return 401;
    case "ACCOUNT_LOCKED": return 423;
    case "KYC_PENDING":
    case "KYC_REJECTED":
    case "PARTY_NOT_VERIFIED":
    case "PAYER_NOT_VERIFIED":
    case "PAYEE_NOT_VERIFIED":
    case "USER_NOT_VERIFIED":
    case "FORBIDDEN": return 403;
    case "QR_EXPIRED":
    case "QR_ALREADY_USED":
    case "QR_PAYLOAD_MISMATCH":
    case "QR_NOT_FOUND":
    case "INSUFFICIENT_FUNDS":
    case "ROUNDED_TO_ZERO":
    case "INVALID_AMOUNT":
    case "SAME_CURRENCY":
    case "VALIDATION_ERROR":
    case "USER_NOT_FOUND":
    case "SELF_TRANSFER_FORBIDDEN":
    case "SELF_PAYMENT_FORBIDDEN":
    case "WALLETS_NOT_READY":
    case "PAYER_WALLET_MISSING": return 422;
    case "RATE_LIMITED": return 429;
    case "NO_ACTIVE_RATE": return 503;
    default: return 400;
  }
}

// map PostgreSQL exception message prefixes to AppError codes
export function mapDbError(e: any): AppError {
  const msg: string = String(e && e.message || "");
  const known = [
    "QR_NOT_FOUND", "QR_ALREADY_USED", "QR_EXPIRED", "QR_PAYLOAD_MISMATCH",
    "PAYER_WALLET_MISSING", "SELF_PAYMENT_FORBIDDEN", "PAYEE_NOT_VERIFIED",
    "PAYER_NOT_VERIFIED", "INSUFFICIENT_FUNDS", "SAME_CURRENCY", "INVALID_AMOUNT",
    "WALLETS_NOT_READY", "USER_NOT_VERIFIED", "ROUNDED_TO_ZERO",
    "NO_ACTIVE_RATE", "SELF_TRANSFER_FORBIDDEN", "PARTY_NOT_VERIFIED",
    "IDENTITY LOCKED",
  ];
  for (const k of known) {
    if (msg.includes(k)) {
      if (k === "IDENTITY LOCKED") return new AppError("IDENTITY_LOCKED", "identity fields are immutable", 422);
      if (k === "INSUFFICIENT_FUNDS") return new AppError("INSUFFICIENT_FUNDS", msg, 422);
      return new AppError(k, msg);
    }
  }
  if (msg.includes("duplicate key value violates unique constraint")) {
    if (msg.includes("ux_users_national_id")) return new AppError("NATIONAL_ID_TAKEN", "national id already registered", 422);
    if (msg.includes("ux_users_phone")) return new AppError("PHONE_TAKEN", "phone already registered", 422);
    return new AppError("DUPLICATE", msg, 422);
  }
  return new AppError("DB_ERROR", msg, 500);
}

// ── Argon2id password hashing ──
import { hash, verify } from "@node-rs/argon2";
const argonOpts = {
  memoryCost: 19456, // 19 MiB (OWASP recommended)
  timeCost: 2,
  parallelism: 1,
};
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, argonOpts);
}
export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try { return await verify(hashValue, plain); } catch { return false; }
}

// ── JWT ──
import jwt from "jsonwebtoken";
export interface AccessClaims { uid: number; role: "user" | "admin"; kyc: string; }
export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.accessTokenTtlSec });
}
export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.jwtSecret) as AccessClaims;
}
export function signRefreshToken(uid: number, jti: string): string {
  return jwt.sign({ uid, jti }, config.jwtRefreshSecret, { expiresIn: config.refreshTokenTtlDays * 24 * 3600 });
}
export function verifyRefreshToken(token: string): { uid: number; jti: string } {
  return jwt.verify(token, config.jwtRefreshSecret) as { uid: number; jti: string };
}

// ── HMAC for QR payloads ──
import crypto from "crypto";
export function hmacHex(data: string): string {
  return crypto.createHmac("sha256", config.qrHmacSecret).update(data).digest("hex");
}
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data as any).digest("hex");
}
export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

// ── money helpers ──
export const CCY_SCALE: Record<string, number> = { ILS: 100, USD: 100, JOD: 1000 };
export function toMinor(units: number | string, ccy: string): number {
  const s = CCY_SCALE[ccy];
  if (!s) throw new AppError("VALIDATION_ERROR", `unsupported currency ${ccy}`);
  const n = typeof units === "string" ? parseFloat(units) : units;
  if (!isFinite(n) || n < 0) throw new AppError("VALIDATION_ERROR", "invalid amount");
  return Math.round(n * s);
}
export function fromMinor(minor: number, ccy: string): string {
  const s = CCY_SCALE[ccy];
  return (minor / s).toFixed(ccy === "JOD" ? 3 : 2);
}
