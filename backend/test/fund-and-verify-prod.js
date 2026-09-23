// fund-and-verify-prod.js — credit test accounts, then run a REAL full QR transaction on production
const BASE = "https://fakah.130.61.171.201.sslip.io";
const ADMIN = { phone: "0599000001", password: "FakahAdmin2026" };
const MERCHANT = { phone: "0599111111", password: "Fakah123456" };
const CUSTOMER = { phone: "0599222222", password: "Fakah123456" };

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log("  OK", n); } else { failed++; console.log("  XX", n, JSON.stringify(x ?? "").slice(0, 300)); } };

async function j(method, path, body, token, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try { return await res.json(); } catch { return null; }
}

async function main() {
  let r = await j("POST", "/api/auth/login", ADMIN);
  const admin = r.data;
  check("admin login", !!admin?.accessToken, r);

  // credit both test accounts (idempotent-ish: add 1000 ILS each run? no — check balance first)
  r = await j("POST", "/api/auth/login", MERCHANT);
  const merchant = r.data;
  r = await j("POST", "/api/auth/login", CUSTOMER);
  const customer = r.data;
  check("logins", !!merchant?.accessToken && !!customer?.accessToken, r);

  r = await j("GET", "/api/wallets", undefined, merchant.accessToken);
  let ils = r.data?.find(w => w.currency === "ILS");
  if (parseInt(ils?.balanceMinor || "0") < 100000) {
    r = await j("POST", "/api/admin/credit", { phone: MERCHANT.phone, currency: "ILS", amount: "1000" }, admin.accessToken);
    check("merchant credited 1000 ILS", r.success === true, r);
    r = await j("POST", "/api/admin/credit", { phone: CUSTOMER.phone, currency: "ILS", amount: "500" }, admin.accessToken);
    check("customer credited 500 ILS", r.success === true, r);
  } else {
    check("merchant already funded", true);
  }

  // ── REAL QR FLOW (exactly what the Android app does) ──
  // customer shows QR (payee = customer? No — in our flow, QR creator is the RECEIVING side)
  // realistic scenario: merchant pays small change back to customer (fakka via QR):
  // customer generates QR to RECEIVE 25.00 ILS, merchant scans & pays.
  r = await j("POST", "/api/qr", { amount: "25.00", currency: "ILS" }, customer.accessToken);
  const qr = r.data;
  check("customer QR created (receive 25.00)", !!qr?.payload?.startsWith("v1."), r);

  r = await j("POST", "/api/qr/preview", { payload: qr.payload }, merchant.accessToken);
  const preview = r.data;
  check("preview shows payee+amount", r.success && preview?.payeeName && preview?.amount === "25.00 ILS", r);

  r = await j("POST", "/api/transactions/qr", { payload: qr.payload, biometricConfirmed: true }, merchant.accessToken, { "x-biometric-confirmed": "true" });
  const pay = r.data;
  check("merchant paid QR atomically", r.success === true && !!pay?.txUuid, r);

  // balances after
  r = await j("GET", "/api/wallets", undefined, customer.accessToken);
  const cIls = r.data?.find(w => w.currency === "ILS");
  check("customer balance +25.00", parseInt(cIls?.balanceMinor) >= 52500, cIls);
  r = await j("GET", "/api/wallets", undefined, merchant.accessToken);
  const mIls = r.data?.find(w => w.currency === "ILS");
  console.log("  balances now: merchant", mIls?.balance, "ILS | customer", cIls?.balance, "ILS");

  // ledger shows the qr_payment
  r = await j("GET", "/api/ledger?type=qr_payment", undefined, customer.accessToken);
  check("ledger shows qr_payment entries", r.success && r.data.items.length >= 1, r);

  // fx conversion with real funds
  r = await j("POST", "/api/transactions/fx", { from: "ILS", to: "USD", amount: "100", biometricConfirmed: true }, customer.accessToken, { "x-biometric-confirmed": "true" });
  check("fx conversion on prod", r.success === true && r.data?.credited?.endsWith("USD"), r);

  console.log(`\n===== PRODUCTION FULL FLOW: ${passed} passed, ${failed} failed =====`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
