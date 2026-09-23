// pdfworker.ts — runs in a Worker Thread: renders the official Arabic PDF statement
import { workerData, parentPort } from "worker_threads";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import pg from "pg";
const { reshape } = require("arabic-persian-reshaper");

const { job, outPath, fontsDir } = workerData as {
  job: { id: number; user_id: number; from_date: string; to_date: string; currencies: string; full_name: string; phone: string; national_id: string };
  outPath: string;
  fontsDir: string;
};

const CCY_SCALE: Record<string, number> = { ILS: 100, USD: 100, JOD: 1000 };
function fmt(minor: number, ccy: string): string {
  return (minor / CCY_SCALE[ccy]).toFixed(ccy === "JOD" ? 3 : 2);
}

// Arabic display string: reshape to presentation forms + reverse visual order
function ar(text: string): string {
  try {
    return reshape(text).split("").reverse().join("");
  } catch {
    return text;
  }
}

const TX_LABEL: Record<string, string> = {
  fakka_deposit: "فكة رقمية",
  qr_payment: "دفع بالمسح QR",
  p2p_transfer: "تحويل بين الأطراف",
  fx_conversion: "تحويل عملة",
};

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const ccyList = job.currencies.split(",").filter(Boolean);
    const doc = new PDFDocument({ size: "A4", margin: 50, layout: "portrait" });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const amiri = path.join(fontsDir, "Amiri-Regular.ttf");
    const amiriBold = path.join(fontsDir, "Amiri-Bold.ttf");
    doc.registerFont("amiri", amiri);
    doc.registerFont("amiri-bold", amiriBold);
    doc.registerFont("helv", "Helvetica");

    const W = doc.page.width; // 595
    const L = 50, R = W - 50;
    const rightText = (text: string, y: number, size = 11, bold = false) => {
      doc.font(bold ? "amiri-bold" : "amiri").fontSize(size).fillColor("#1a1a1a");
      doc.text(ar(text), L, y, { width: R - L, align: "right" });
    };
    const leftText = (text: string, y: number, size = 10) => {
      doc.font("helv").fontSize(size).fillColor("#333333");
      doc.text(text, L, y, { width: R - L, align: "left" });
    };

    // ── header band ──
    doc.rect(0, 0, W, 96).fill("#1A1A1A");
    doc.fillColor("#C9A84C").font("helv").fontSize(13)
      .text("FAKAH DIGITAL WALLET — OFFICIAL ACCOUNT STATEMENT", L, 26, { width: R - L, align: "left" });
    doc.font("amiri-bold").fontSize(20).fillColor("#FFFFFF")
      .text(ar("كشف حساب رسمي — محفظة الفكة الرقمية"), L, 48, { width: R - L, align: "right" });
    doc.fillColor("#B0B8C0").font("helv").fontSize(9)
      .text(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, L, 78, { align: "left", width: R - L });

    let y = 118;
    // ── account info ──
    rightText("بيانات صاحب الحساب", y, 14, true); y += 24;
    const info: Array<[string, string]> = [
      ["الاسم الكامل", job.full_name],
      ["رقم الجوال", job.phone],
      ["رقم الهوية", job.national_id],
      ["الفترة", `${job.from_date} حتى ${job.to_date}`],
    ];
    for (const [label, value] of info) {
      doc.font("amiri").fontSize(11).fillColor("#1a1a1a")
        .text(ar(`${label}: `), L, y, { width: R - L, align: "right", continued: false });
      // value drawn on the left side of the same line
      doc.font("helv").fontSize(11).fillColor("#111111")
        .text(value, L, y, { width: R - L, align: "left" });
      y += 20;
    }
    y += 10;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor("#C9A84C").stroke();
    y += 16;

    // ── per-currency statement tables ──
    for (const ccy of ccyList) {
      const wallet = (await client.query(
        `SELECT w.id, w.balance_minor FROM wallets w WHERE w.user_id = $1 AND w.currency = $2`,
        [job.user_id, ccy]
      )).rows[0];
      if (!wallet) continue;

      // opening balance = current balance - sum(credits) + sum(debits) in period
      const sums = (await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS credited,
           COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_minor ELSE 0 END), 0) AS debited
         FROM audit_ledger WHERE wallet_id = $1
           AND created_at >= $2::date AND created_at < ($3::date + 1)`,
        [wallet.id, job.from_date, job.to_date]
      )).rows[0];
      const opening = wallet.balance_minor - Number(sums.credited) + Number(sums.debited);

      rightText(`الحركات بعملة ${ccy}`, y, 13, true); y += 8;
      leftText(`Currency: ${ccy}`, y); y += 18;

      // table header (RTL columns: rightmost first)
      const cols = [
        { title: "التاريخ", x: R - 95, w: 95, align: "left" as const },
        { title: "البيان", x: R - 260, w: 165, align: "right" as const },
        { title: "مدين", x: L + 130, w: 85, align: "right" as const },
        { title: "دائن", x: L + 55, w: 75, align: "right" as const },
        { title: "الرصيد", x: L, w: 55, align: "right" as const },
      ];
      doc.rect(L, y - 4, R - L, 22).fill("#F5F2E8");
      for (const c of cols) {
        doc.font("amiri-bold").fontSize(10).fillColor("#3A3A30")
          .text(ar(c.title), c.x - c.w, y, { width: c.w, align: c.align });
      }
      y += 22;

      const rows = (await client.query(
        `SELECT a.direction, a.amount_minor, a.balance_after, a.tx_type, a.created_at,
                cp.full_name AS counterparty
         FROM audit_ledger a
         LEFT JOIN users cp ON cp.id = a.counterparty_user_id
         WHERE a.wallet_id = $1
           AND a.created_at >= $2::date AND a.created_at < ($3::date + 1)
         ORDER BY a.created_at ASC, a.id ASC`,
        [wallet.id, job.from_date, job.to_date]
      )).rows;

      let balance = opening;
      for (const r of rows) {
        if (y > doc.page.height - 90) { doc.addPage(); y = 60; }
        const isDebit = r.direction === "debit";
        balance = r.balance_after;
        const cells = [
          { text: new Date(r.created_at).toISOString().slice(0, 16).replace("T", " "), x: R - 95, w: 95, align: "left" as const, font: "helv", size: 8.5 },
          { text: TX_LABEL[r.tx_type] || r.tx_type, x: R - 260, w: 165, align: "right" as const, font: "amiri", size: 10, arabic: true },
          { text: isDebit ? fmt(r.amount_minor, ccy) : "—", x: L + 130, w: 85, align: "right" as const, font: "helv", size: 9.5 },
          { text: !isDebit ? fmt(r.amount_minor, ccy) : "—", x: L + 55, w: 75, align: "right" as const, font: "helv", size: 9.5 },
          { text: fmt(balance, ccy), x: L, w: 55, align: "right" as const, font: "helv", size: 9.5 },
        ];
        for (const c of cells) {
          doc.font(c.font as string).fontSize(c.size as number).fillColor("#24313F");
          const txt = c.arabic ? ar(c.text) : c.text;
          doc.text(txt, c.x - c.w, y, { width: c.w, align: c.align });
        }
        y += 18;
        if (r.counterparty) {
          doc.font("amiri").fontSize(8.5).fillColor("#6B7280")
            .text(ar(`الطرف: ${r.counterparty}`), L, y - 4, { width: R - L, align: "right" });
        }
      }

      y += 10;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor("#DDD5C0").stroke();
      y += 14;
      rightText(`رصيد افتتاحي: ${fmt(opening, ccy)} ${ccy}    —    رصيد ختامي: ${fmt(balance, ccy)} ${ccy}`, y, 11, true);
      y += 34;
    }

    // ── integrity footer ──
    if (y > doc.page.height - 120) { doc.addPage(); y = 60; }
    doc.rect(L, y, R - L, 58).fill("#FBF7EC");
    rightText("هذا الكشف مولّد آلياً من الدفتر المحاسبي غير القابل للتعديل، ويُعتد به للاطلاع الشخصي.", y + 10, 10);
    rightText("التحقق من سلامة الملف عبر بصمة SHA-256 المدونة أدناه.", y + 28, 10);
    y += 58;
    doc.font("helv").fontSize(8).fillColor("#6B7280")
      .text(`Job #${job.id} — user ${job.user_id}`, L, y, { align: "left", width: R - L });

    // finalize: wait for stream then hash
    await new Promise<void>((resolve) => {
      stream.on("finish", () => resolve());
      doc.end();
    });
    const sha = crypto.createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
    parentPort?.postMessage({ sha256: sha });
  } catch (e: any) {
    parentPort?.postMessage({ error: String(e?.message || e) });
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((e) => parentPort?.postMessage({ error: String(e) }));
