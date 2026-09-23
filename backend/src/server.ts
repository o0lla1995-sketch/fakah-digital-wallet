// server.ts — Fakah Digital Wallet API (assembly + boot)
import http from "http";
import express from "express";
import rateLimit from "express-rate-limit";
import { config, ensureDirs, AppError, hashPassword } from "./core";
import { waitForDb, runMigrations, query, pool } from "./db";
import authRouter, { requireAuth, adminRouter } from "./auth";
import walletsRouter, { startRatesScheduler } from "./wallets";
import transactionsRouter from "./transactions";
import ledgerRouter from "./ledger";
import statementsRouter, { recoverStuckJobs } from "./statements";
import { initFcm } from "./notify";
import { attachWs } from "./ws";

async function bootstrap(): Promise<void> {
  ensureDirs();
  await waitForDb();
  const applied = await runMigrations();
  if (applied.length) console.log("[db] migrations applied:", applied.join(", "));
  await seedAdmin();
  initFcm();
  startRatesScheduler();
  await recoverStuckJobs();
}

async function seedAdmin(): Promise<void> {
  if (!config.adminPhone || !config.adminPassword) {
    console.warn("[admin] ADMIN_PHONE/ADMIN_PASSWORD not set — admin seeded only if already present");
    return;
  }
  const existing = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existing.rows.length > 0) return;
  try {
    await query(
      `INSERT INTO users (full_name, national_id, phone, password_hash, kyc_status, role)
       VALUES ($1, $2, $3, $4, 'approved', 'admin')`,
      [config.adminFullName, config.adminNationalId, config.adminPhone, await hashPassword(config.adminPassword)]
    );
    console.log("[admin] administrator account created");
  } catch (e: any) {
    console.warn("[admin] seed skipped:", e.message);
  }
}

// ── app ──
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// basic dual rate limiting (per-IP global + per-IP for sensitive endpoints)
const globalLimiter = rateLimit({ windowMs: 60_000, limit: 300 });
const sensitiveLimiter = rateLimit({ windowMs: 60_000, limit: 30 });
app.use(globalLimiter);
app.use("/api/auth/login", sensitiveLimiter);
app.use("/api/transactions", sensitiveLimiter);
app.use("/api/qr", rateLimit({ windowMs: 60_000, limit: 120 }));

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up", ts: Date.now() });
  } catch {
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "Fakah Digital Wallet API",
    version: "1.0.0",
    docs: "see the architecture study (Table 5) for the endpoint matrix",
  });
});

app.use("/api/auth", authRouter);
app.use("/api", adminRouter);
app.use("/api", walletsRouter);
app.use("/api", transactionsRouter);
app.use("/api", ledgerRouter);
app.use("/api", statementsRouter);

// central error handler → unified envelope
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const appErr = err instanceof AppError ? err : new AppError("INTERNAL", String(err?.message || err), 500);
  if (appErr.httpStatus >= 500) console.error("[api]", err);
  res.status(appErr.httpStatus).json({
    success: false,
    error: { code: appErr.code, message: appErr.message, httpStatus: appErr.httpStatus },
  });
});

const server = http.createServer(app);

bootstrap().then(() => {
  attachWs(server);
  server.listen(config.port, () => {
    console.log(`[api] Fakah backend listening on :${config.port} (${config.nodeEnv})`);
  });
}).catch((e) => {
  console.error("[boot] fatal:", e);
  process.exit(1);
});

process.on("SIGTERM", () => { server.close(() => pool.end()); process.exit(0); });
process.on("SIGINT", () => { server.close(() => pool.end()); process.exit(0); });
