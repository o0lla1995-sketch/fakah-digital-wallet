// notify.ts — FCM dispatcher + in-process event bus (settlements → push + ws)
import { query } from "./db";
import { config, AppError } from "./core";

// ── FCM (no-op until service account configured) ──
let fcmApp: any = null;

export function initFcm(): boolean {
  if (!config.firebaseServiceAccountB64) {
    console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT_B64 not set — push notifications disabled (API stays fully functional)");
    return false;
  }
  try {
    const serviceAccount = JSON.parse(
      Buffer.from(config.firebaseServiceAccountB64, "base64").toString("utf-8")
    );
    const admin = require("firebase-admin");
    fcmApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("[fcm] Firebase Admin initialized for project:", serviceAccount.project_id);
    return true;
  } catch (e: any) {
    console.warn("[fcm] init failed — notifications disabled:", e.message);
    return false;
  }
}

interface PushMessage {
  userId: number;
  title: string;
  body: string;
  data: Record<string, string>;
}

export async function pushToUser(msg: PushMessage): Promise<void> {
  if (!fcmApp) return;
  const res = await query<{ token: string }>(
    `SELECT token FROM fcm_tokens WHERE user_id = $1 AND active`, [msg.userId]
  );
  if (res.rows.length === 0) return;
  const admin = require("firebase-admin");
  const dead: string[] = [];
  await Promise.all(res.rows.map(async (r) => {
    try {
      await admin.messaging().send({
        token: r.token,
        notification: { title: msg.title, body: msg.body },
        data: msg.data,
        android: { priority: "high" },
      });
    } catch (e: any) {
      const code = e?.errorInfo?.code || e?.code || "";
      if (String(code).includes("unregistered") || String(code).includes("INVALID_ARGUMENT")) {
        dead.push(r.token);
      }
    }
  }));
  if (dead.length) {
    await query(`UPDATE fcm_tokens SET active = false WHERE token = ANY($1)`, [dead]).catch(() => undefined);
  }
}

// retry wrapper with exponential backoff (5 attempts)
async function withRetry(fn: () => Promise<void>, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await fn(); return; }
    catch (e: any) {
      if (attempt === 5) { console.error(`[notify] ${label} failed permanently:`, e.message); return; }
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
    }
  }
}

// ── event bus ──
type LiveEvent = { type: string; payload: any };
type Listener = (ev: LiveEvent) => void;
const listeners: Listener[] = [];

export function onEvent(fn: Listener): void { listeners.push(fn); }

function emit(ev: LiveEvent): void {
  for (const l of listeners) {
    try { l(ev); } catch { /* isolated */ }
  }
}

// ── high-level notifications after settlement ──
export interface SettlementNotice {
  txUuid: string;
  payer: { userId: number; name: string; balanceMinor: number; ccy: string };
  payee: { userId: number; name: string; balanceMinor: number; ccy: string };
  amountMinor: number;
  currency: string;
  amountText: string;
  txType: "qr_payment" | "p2p_transfer" | "fx_conversion" | "fakka_deposit";
}

export async function notifySettlement(n: SettlementNotice): Promise<void> {
  // live channel first (ws listeners are sync)
  emit({ type: "settlement", payload: n });
  emit({ type: "wallet_update", payload: { userId: n.payer.userId, balanceMinor: n.payer.balanceMinor, ccy: n.payer.ccy, txUuid: n.txUuid } });
  emit({ type: "wallet_update", payload: { userId: n.payee.userId, balanceMinor: n.payee.balanceMinor, ccy: n.payee.ccy, txUuid: n.txUuid } });

  // push notifications (async, retried, never blocking the response)
  if (n.txType !== "fx_conversion") {
    setImmediate(() => {
      withRetry(() => pushToUser({
        userId: n.payer.userId,
        title: "تم الدفع بنجاح",
        body: `دفعت ${n.amountText} إلى ${n.payee.name} — رقم العملية ${n.txUuid.slice(0, 8)}`,
        data: { type: "tx_completed", txUuid: n.txUuid, role: "payer", balance: String(n.payer.balanceMinor), ccy: n.currency },
      }), `payer-push ${n.txUuid}`).catch(() => undefined);
      withRetry(() => pushToUser({
        userId: n.payee.userId,
        title: "استلمت مبلغاً",
        body: `استلمت ${n.amountText} من ${n.payer.name} — رقم العملية ${n.txUuid.slice(0, 8)}`,
        data: { type: "tx_received", txUuid: n.txUuid, role: "payee", balance: String(n.payee.balanceMinor), ccy: n.currency },
      }), `payee-push ${n.txUuid}`).catch(() => undefined);
    });
  }
}

export async function notifyKycDecision(userId: number, approved: boolean, reason?: string): Promise<void> {
  emit({ type: "kyc_decision", payload: { userId, approved } });
  setImmediate(() => {
    withRetry(() => pushToUser({
      userId,
      title: approved ? "تم توثيق حسابك" : "نتيجة مراجعة التوثيق",
      body: approved
        ? "أصبح حسابك موثقاً ومفعلاً بالكامل — يمكنك الآن استقبال وإرسال الفكة الرقمية"
        : (reason ? `تم رفض التوثيق: ${reason}` : "تم رفض طلب التوثيق، يرجى مراجعة المستندات وإعادة الرفع"),
      data: { type: approved ? "kyc_approved" : "kyc_rejected", reason: reason || "" },
    }), `kyc-push ${userId}`).catch(() => undefined);
  });
}

export async function notifySecurity(userId: number, title: string, body: string): Promise<void> {
  setImmediate(() => {
    withRetry(() => pushToUser({
      userId, title, body, data: { type: "security" },
    }), `security-push ${userId}`).catch(() => undefined);
  });
}
