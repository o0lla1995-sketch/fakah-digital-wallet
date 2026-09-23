// smoke-prod.js — production smoke test + create two ready-to-use verified test accounts
const BASE = "https://fakah.130.61.171.201.sslip.io";
const ADMIN_PHONE = "0599000001";
const ADMIN_PASS = "FakahAdmin2026";

// test accounts for the user's phone testing
const MERCHANT = { phone: "0599111111", nid: "401234567", name: "حساب تجريبي تاجر" };
const CUSTOMER = { phone: "0599222222", nid: "402345678", name: "حساب تجريبي زبون" };
const TEST_PASS = "Fakah123456";

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log("  OK", name); }
  else { failed++; console.log("  XX", name, JSON.stringify(extra ?? "").slice(0, 250)); }
};

async function j(method, path, body, token, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { }
  return data;
}

async function register(u) {
  const fd = new FormData();
  fd.append("fullName", u.name);
  fd.append("nationalId", u.nid);
  fd.append("phone", u.phone);
  fd.append("password", TEST_PASS);
  for (const f of ["id_front", "id_back", "selfie"]) {
    fd.append(f, new Blob([new Uint8Array(64)], { type: "image/png" }), `${f}.png`);
  }
  const res = await fetch(BASE + "/api/auth/register", { method: "POST", body: fd });
  return res.json();
}

async function main() {
  console.log("── production smoke against", BASE, "──");

  // 0. health
  let r = await j("GET", "/healthz");
  check("healthz", r && r.status === "ok" && r.db === "up", r);

  // 1. admin login
  r = await j("POST", "/api/auth/login", { phone: ADMIN_PHONE, password: ADMIN_PASS });
  const admin = r && r.data;
  check("admin login (seeded)", !!(admin && admin.role === "admin"), r);

  // 2. register test accounts (idempotent — if exist, just login)
  for (const u of [MERCHANT, CUSTOMER]) {
    r = await register(u);
    if (r && r.success) {
      check(`registered ${u.phone}`, true, r);
      // approve
      r = await j("POST", `/api/admin/kyc/${r.data.userId}/decision`, { approve: true }, admin.accessToken);
      check(`approved ${u.phone}`, r && r.success, r);
    } else {
      check(`register ${u.phone} (already exists?)`, r && r.error && ["PHONE_TAKEN", "NATIONAL_ID_TAKEN"].includes(r.error.code), r);
    }
  }

  // 3. login both + fund merchant via... no admin funding endpoint — use fx? We need initial balance.
  //    For smoke: verify wallets exist & zero, run fx conversion between user's own wallets needs funds.
  //    Use QR flow with zero balances → expect INSUFFICIENT_FUNDS (validates atomic path on prod).
  r = await j("POST", "/api/auth/login", { phone: MERCHANT.phone, password: TEST_PASS });
  const merchant = r && r.data;
  check("merchant login", !!(merchant && merchant.accessToken), r);
  r = await j("POST", "/api/auth/login", { phone: CUSTOMER.phone, password: TEST_PASS });
  const customer = r && r.data;
  check("customer login", !!(customer && customer.accessToken), r);

  // 4. wallets
  r = await j("GET", "/api/wallets", undefined, customer.accessToken);
  check("customer 3 wallets", r && r.success && r.data && r.data.length === 3, r);

  // 5. rates live
  r = await j("GET", "/api/rates", undefined, customer.accessToken);
  check("rates available", r && r.success && r.data && r.data.pairs && r.data.pairs["USD/ILS"], r);

  // 6. QR create + execute (expect INSUFFICIENT_FUNDS with zero balance — proves atomic function works on prod)
  r = await j("POST", "/api/qr", { amount: "10.00", currency: "ILS" }, customer.accessToken);
  const qr = r && r.data;
  check("qr created", !!(qr && qr.payload), r);
  if (qr && qr.payload) {
    r = await j("POST", "/api/transactions/qr", { payload: qr.payload, biometricConfirmed: true }, merchant.accessToken, { "x-biometric-confirmed": "true" });
    check("atomic settle path reached (INSUFFICIENT_FUNDS expected with zero balance)",
      r && r.success === false && r.error && r.error.code === "INSUFFICIENT_FUNDS", r);
  }

  // 7. ledger + statement endpoints
  r = await j("GET", "/api/ledger?currency=ILS", undefined, customer.accessToken);
  check("ledger filter", r && r.success, r);
  const today = new Date().toISOString().slice(0, 10);
  r = await j("POST", "/api/statements", { from: today, to: today, currencies: ["ILS"] }, customer.accessToken);
  check("statement job queued", r && r.success && r.data && r.data.jobId > 0, r);
  if (r && r.success && r.data) {
    let st = null;
    for (let i = 0; i < 16; i++) {
      await new Promise(res => setTimeout(res, 1500));
      const b = await j("GET", `/api/statements/${r.data.jobId}`, undefined, customer.accessToken);
      st = b && b.data;
      if (st && (st.status === "done" || st.status === "failed")) break;
    }
    check("statement PDF generated on prod", st && st.status === "done" && st.downloadUrl, st);
    if (st && st.downloadUrl) {
      const url = st.downloadUrl.startsWith("http") ? st.downloadUrl : BASE + st.downloadUrl;
      const dl = await fetch(url, { headers: { authorization: `Bearer ${customer.accessToken}` } });
      const buf = Buffer.from(await dl.arrayBuffer());
      check("pdf download over https", dl.status === 200 && buf.slice(0, 4).toString() === "%PDF", { status: dl.status });
    }
  }

  console.log(`\n========== PRODUCTION SMOKE: ${passed} passed, ${failed} failed ==========`);
  console.log("merchant test account:", MERCHANT.phone, "/ pass:", TEST_PASS);
  console.log("customer test account:", CUSTOMER.phone, "/ pass:", TEST_PASS);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("SMOKE FATAL:", e); process.exit(1); });
