// statements.ts — PDF statement jobs (queued in DB, rendered by a worker thread)
import { Router, Request, Response } from "express";
import { z } from "zod";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { Worker } from "worker_threads";
import { AppError, config, sha256Hex } from "./core";
import { query } from "./db";
import { requireAuth, requireKyc, ok, fail } from "./auth";
import { pushToUser } from "./notify";

const router = Router();

const stmtSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currencies: z.array(z.enum(["ILS", "USD", "JOD"])).min(1).optional(),
});

// POST /api/statements — enqueue a generation job (returns immediately)
router.post("/statements", requireAuth, requireKyc, async (req, res) => {
  try {
    const parsed = stmtSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message);
    const { from, to, currencies } = parsed.data;
    const uid = (req as any).auth.uid;

    const ins = await query(
      `INSERT INTO statement_jobs (user_id, from_date, to_date, currencies)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [uid, from, to, (currencies || ["ILS", "USD", "JOD"]).join(",")]
    );
    const job = ins.rows[0];

    // dispatch to background worker — never on the request path
    setImmediate(() => runStatementJob(job.id).catch(e =>
      console.error("[statements] job", job.id, "failed:", e.message)));

    ok(res, { jobId: job.id, status: job.status, pollUrl: `/api/statements/${job.id}` });
  } catch (e) { fail(res, e); }
});

// GET /api/statements/:id — job status + signed temporary download link
router.get("/statements/:id", requireAuth, requireKyc, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const uid = (req as any).auth.uid;
    const r = await query(
      `SELECT id, status, from_date, to_date, currencies, file_key, file_sha256, error, created_at, finished_at
       FROM statement_jobs WHERE id = $1 AND user_id = $2`, [id, uid]
    );
    if (r.rows.length === 0) throw new AppError("USER_NOT_FOUND", "job not found");
    const j = r.rows[0];

    let downloadUrl: string | null = null;
    if (j.status === "done" && j.file_key) {
      downloadUrl = buildSignedLink(j.id, j.file_key);
    }
    ok(res, {
      jobId: j.id, status: j.status, from: j.from_date, to: j.to_date,
      currencies: j.currencies ? j.currencies.split(",") : [],
      sha256: j.file_sha256, error: j.error,
      createdAt: j.created_at, finishedAt: j.finished_at,
      downloadUrl, downloadExpiresInSec: 600,
    });
  } catch (e) { fail(res, e); }
});

// GET /api/statements/:id/download?sig=... — signed, expiring file download
router.get("/statements/:id/download", requireAuth, requireKyc, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const uid = (req as any).auth.uid;
    const sig = String(req.query.sig || "");
    const exp = parseInt(String(req.query.exp || "0"), 10);

    if (!exp || Date.now() / 1000 > exp) throw new AppError("VALIDATION_ERROR", "link expired", 403);
    const expected = statementSignature(id, exp);
    if (sig !== expected) throw new AppError("VALIDATION_ERROR", "bad signature", 403);

    const r = await query(
      `SELECT file_key FROM statement_jobs WHERE id = $1 AND user_id = $2 AND status = 'done'`,
      [id, uid]
    );
    if (r.rows.length === 0 || !r.rows[0].file_key) throw new AppError("USER_NOT_FOUND", "statement not ready");
    const file = path.join(config.statementsDir, r.rows[0].file_key);
    if (!fs.existsSync(file)) throw new AppError("USER_NOT_FOUND", "file missing");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="fakah-statement-${id}.pdf"`);
    fs.createReadStream(file).pipe(res);
  } catch (e) { fail(res, e); }
});

function statementSignature(jobId: number, exp: number): string {
  return sha256Hex(`stmt|${jobId}|${exp}`).slice(0, 32);
}
function buildSignedLink(jobId: number, fileKey: string): string {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = statementSignature(jobId, exp);
  const base = config.publicBaseUrl || "";
  return `${base}/api/statements/${jobId}/download?exp=${exp}&sig=${sig}`;
}

// ── background job execution (worker thread → main thread callback) ──
export async function runStatementJob(jobId: number): Promise<void> {
  await query(`UPDATE statement_jobs SET status = 'processing' WHERE id = $1 AND status = 'queued'`, [jobId]);
  const job = (await query(
    `SELECT j.id, j.user_id, j.from_date, j.to_date, j.currencies, u.full_name, u.phone, u.national_id
     FROM statement_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = $1`, [jobId]
  )).rows[0];
  if (!job) return;

  const fileKey = `stmt-${jobId}-${crypto.randomBytes(6).toString("hex")}.pdf`;
  const outPath = path.join(config.statementsDir, fileKey);

  return new Promise<void>((resolve) => {
    const worker = new Worker(path.join(__dirname, "pdfworker.js"), {
      workerData: { job: { ...job, id: jobId }, outPath, fontsDir: config.fontsDir },
    });
    worker.on("message", (m) => {
      if (m.error) {
        query(`UPDATE statement_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [jobId, String(m.error).slice(0, 400)]).catch(() => undefined);
      } else {
        const sha = m.sha256 as string;
        query(
          `UPDATE statement_jobs SET status = 'done', file_key = $2, file_sha256 = $3, finished_at = now() WHERE id = $1`,
          [jobId, fileKey, sha]
        ).then(() => {
          const link = buildSignedLink(jobId, fileKey);
          return pushToUser({
            userId: job.user_id,
            title: "كشفك جاهز للتنزيل",
            body: "اكتمل توليد كشف الحساب المطلوب",
            data: { type: "statement_ready", jobId: String(jobId), downloadUrl: link },
          });
        }).catch(() => undefined);
      }
      resolve();
    });
    worker.on("error", (e) => {
      query(`UPDATE statement_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [jobId, String(e.message).slice(0, 400)]).catch(() => undefined);
      resolve();
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        query(`UPDATE statement_jobs SET status = 'failed', error = $2 WHERE id = $1`,
          [jobId, `worker exited code ${code}`]).catch(() => undefined);
      }
      resolve();
    });
  });
}

// recover orphaned jobs at boot (server restarted mid-generation)
export async function recoverStuckJobs(): Promise<void> {
  const r = await query(`SELECT id FROM statement_jobs WHERE status IN ('queued','processing') LIMIT 50`);
  for (const row of r.rows) {
    runStatementJob(row.id).catch(() => undefined);
  }
  if (r.rows.length) console.log(`[statements] recovered ${r.rows.length} stuck job(s)`);
}

export default router;
