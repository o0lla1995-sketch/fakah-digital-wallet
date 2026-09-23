// test/run-e2e.js — full end-to-end test against an embedded PostgreSQL
// Boots PG → runs migrations via server boot → exercises the full API surface.
// NOTE: requires dev-only packages (x64/arm host): npm i -D embedded-postgres @embedded-postgres/linux-x64
let EmbeddedPostgres;
try {
  EmbeddedPostgres = require("embedded-postgres").default;
} catch (e) {
  console.error("embedded-postgres not installed. Run: npm i -D embedded-postgres @embedded-postgres/linux-x64");
  process.exit(2);
}
const fs = require("fs");

const PG_DATA = "/home/z/my-project/fakah/.pgdata";
const PORT = 8090;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("── starting embedded postgres ──");
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA,
    user: "fakah",
    password: "fakah",
    port: 5433,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fakah");
  console.log("── postgres up on :5433 ──");

  process.env.DATABASE_URL = "postgres://fakah:fakah@127.0.0.1:5433/fakah";
  process.env.PORT = String(PORT);
  process.env.JWT_SECRET = "test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret-bbbbbbbbbbbbbbb";
  process.env.QR_HMAC_SECRET = "test-qr-hmac-secret-cccccccccccccc";
  process.env.ADMIN_PHONE = "0599000001";
  process.env.ADMIN_PASSWORD = "Admin123456";
  process.env.DATA_DIR = "/home/z/my-project/fakah/.testdata";
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;

  require("../dist/server.js");
  await waitForServer();

  const base = `http://127.0.0.1:${PORT}`;
  let passed = 0, failed = 0;
  const check = (name, cond, extra) => {
    if (cond) { passed++; console.log("  OK", name); }
    else { failed++; console.log("  XX", name, JSON.stringify(extra ?? "").slice(0, 300)); }
  };

  async function j(method, path, body, token, headers) {
    return await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // 1. health
  let r = await j("GET", "/healthz");
  check("healthz ok", r.status === 200, await r.text());

  // 2. register validation errors
  r = await j("POST", "/api/auth/register", { fullName: "A", nationalId: "123", phone: "0500000000", password: "short" });
  let body = await r.json();
  check("register rejects invalid fields", body.success === false && body.error.code === "VALIDATION_ERROR", body);

  // 3. register two users (multipart with dummy files)
  async function register(phone, nationalId, fullName) {
    const fd = new FormData();
    fd.append("fullName", fullName);
    fd.append("nationalId", nationalId);
    fd.append("phone", phone);
    fd.append("password", "Passw0rd123");
    for (const f of ["id_front", "id_back", "selfie"]) {
      fd.append(f, new Blob([new Uint8Array(64)], { type: "image/png" }), `${f}.png`);
    }
    const res = await fetch(base + "/api/auth/register", { method: "POST", body: fd });
    return res.json();
  }
  let reg1 = await register("0599111111", "401234567", "خالد النجار");
  check("user1 registered pending", reg1.success === true && reg1.data.kycStatus === "pending", reg1);
  let reg1dup = await register("0599111112", "401234567", "سارة عبد الله");
  check("duplicate national id rejected", reg1dup.success === false && reg1dup.error.code === "NATIONAL_ID_TAKEN", reg1dup);
  let reg2 = await register("0599222222", "402345678", "سارة عبد الله");
  check("user2 registered", reg2.success === true, reg2);

  // 4. login
  r = await j("POST", "/api/auth/login", { phone: "0599111111", password: "Passw0rd123" });
  body = await r.json();
  check("user1 login", body.success === true && body.data.accessToken, body);
  const u1 = body.data;
  r = await j("POST", "/api/auth/login", { phone: "0599222222", password: "Passw0rd123" });
  const u2 = (await r.json()).data;
  check("user2 login", !!u2 && !!u2.accessToken, u2);

  // 5. admin login + approve KYC
  r = await j("POST", "/api/auth/login", { phone: "0599000001", password: "Admin123456" });
  const admin = (await r.json()).data;
  check("admin login", admin && admin.role === "admin", admin);
  r = await j("GET", "/api/admin/kyc/pending", undefined, admin.accessToken);
  body = await r.json();
  check("admin sees pending list", body.success === true && body.data.length === 2, body);

  r = await j("POST", `/api/admin/kyc/${reg1.data.userId}/decision`, { approve: true }, admin.accessToken);
  check("user1 approved", (await r.json()).success === true);
  r = await j("POST", `/api/admin/kyc/${reg2.data.userId}/decision`, { approve: true }, admin.accessToken);
  check("user2 approved", (await r.json()).success === true);

  // 6. wallets auto-created
  r = await j("GET", "/api/wallets", undefined, u1.accessToken);
  body = await r.json();
  check("3 wallets created", body.success === true && body.data.length === 3, body);

  // 7. fund user1 ILS directly in DB (simulated initial deposit)
  const db = require("../dist/db.js");
  await db.query(`UPDATE wallets SET balance_minor = 500000 WHERE user_id = $1 AND currency = 'ILS'`, [reg1.data.userId]);
  r = await j("GET", "/api/wallets", undefined, u1.accessToken);
  body = await r.json();
  const ils = body.data.find(w => w.currency === "ILS");
  check("funding applied (5000.00 ILS)", ils && parseInt(ils.balanceMinor) === 500000, body);

  // 8. QR flow end-to-end
  r = await j("POST", "/api/qr", { amount: "25.50", currency: "ILS" }, u2.accessToken);
  let qr = (await r.json()).data;
  check("qr payload created", qr && qr.payload && qr.payload.startsWith("v1."), qr);
  r = await j("POST", "/api/transactions/qr", { payload: qr.payload, biometricConfirmed: true }, u1.accessToken,
    { "x-biometric-confirmed": "true" });
  body = await r.json();
  check("qr executed", body.success === true && parseInt(body.data.newBalanceMinor) === 497450, body);

  // 9. double-spend rejected
  r = await j("POST", "/api/transactions/qr", { payload: qr.payload, biometricConfirmed: true }, u1.accessToken,
    { "x-biometric-confirmed": "true" });
  body = await r.json();
  check("replay rejected (QR_ALREADY_USED)", body.success === false && body.error.code === "QR_ALREADY_USED", body);

  // 10. tampered payload rejected
  const tampered = qr.payload.split(".").slice(0, 6).join(".") + ".deadbeefdeadbeef";
  r = await j("POST", "/api/transactions/qr", { payload: tampered, biometricConfirmed: true }, u1.accessToken,
    { "x-biometric-confirmed": "true" });
  body = await r.json();
  check("tampered signature rejected", body.success === false && body.error.code === "QR_PAYLOAD_MISMATCH", body);

  // 11. insufficient funds
  r = await j("POST", "/api/qr", { amount: "100000", currency: "ILS" }, u2.accessToken);
  const bigQr = (await r.json()).data;
  r = await j("POST", "/api/transactions/qr", { payload: bigQr.payload, biometricConfirmed: true }, u1.accessToken,
    { "x-biometric-confirmed": "true" });
  body = await r.json();
  check("insufficient funds rejected", body.success === false && body.error.code === "INSUFFICIENT_FUNDS", body);

  // 12. biometric gate
  r = await j("POST", "/api/qr", { amount: "1.00", currency: "ILS" }, u2.accessToken);
  const smallQr = (await r.json()).data;
  r = await j("POST", "/api/transactions/qr", { payload: smallQr.payload }, u1.accessToken);
  body = await r.json();
  check("biometric confirmation enforced", body.success === false && body.error.code === "BIOMETRIC_REQUIRED", body);

  // 13. p2p + fakka
  r = await j("POST", "/api/transactions/p2p", { phone: "0599222222", amount: "10", currency: "ILS", biometricConfirmed: true }, u1.accessToken);
  body = await r.json();
  check("p2p transfer ok", body.success === true && parseInt(body.data.newBalanceMinor) === 496450, body);
  r = await j("POST", "/api/transactions/fakka", { phone: "0599111111", amount: "2.50", from: "ILS", to: "ILS", biometricConfirmed: true }, u2.accessToken);
  body = await r.json();
  check("fakka return ok", body.success === true && body.data.customerReceived === "2.50 ILS", body);

  // 14. FX conversion
  r = await j("GET", "/api/rates", undefined, u1.accessToken);
  body = await r.json();
  check("rates available", body.success === true && body.data.pairs["USD/ILS"] && body.data.pairs["USD/ILS"].rate > 0, body);
  r = await j("POST", "/api/transactions/fx", { from: "ILS", to: "USD", amount: "100", biometricConfirmed: true }, u1.accessToken);
  body = await r.json();
  check("fx conversion ok", body.success === true && String(body.data.credited || "").endsWith("USD"), body);

  // 15. ledger filtering
  r = await j("GET", "/api/ledger?currency=ILS&limit=50", undefined, u1.accessToken);
  body = await r.json();
  check("ledger filter currency", body.success === true && body.data.items.every(i => i.currency === "ILS"), body);
  r = await j("GET", "/api/ledger?type=qr_payment", undefined, u1.accessToken);
  body = await r.json();
  check("ledger filter type", body.success === true && body.data.items.every(i => i.type === "qr_payment"), body);

  // 16. statements PDF
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  r = await j("POST", "/api/statements", { from: iso(new Date(today.getTime() - 86400000)), to: iso(today), currencies: ["ILS", "USD"] }, u1.accessToken);
  body = await r.json();
  check("statement job queued", body.success === true && body.data.jobId > 0, body);
  const jobId = body.data && body.data.jobId;
  let st = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    r = await j("GET", `/api/statements/${jobId}`, undefined, u1.accessToken);
    const b = await r.json();
    st = b.data;
    if (st && (st.status === "done" || st.status === "failed")) break;
  }
  check("statement job done", st && st.status === "done", st);
  if (st && st.downloadUrl) {
    const dlUrl = st.downloadUrl.startsWith("http") ? st.downloadUrl : base + st.downloadUrl;
    const dl = await fetch(dlUrl, { headers: { authorization: `Bearer ${u1.accessToken}` } });
    const buf = Buffer.from(await dl.arrayBuffer());
    check("pdf downloadable & valid header", dl.status === 200 && buf.slice(0, 4).toString() === "%PDF", { status: dl.status, head: buf.slice(0, 5).toString() });
    fs.writeFileSync("/home/z/my-project/fakah/test-statement.pdf", buf);
  }

  // 17. token refresh + logout
  r = await j("POST", "/api/auth/refresh", { refreshToken: u1.refreshToken });
  body = await r.json();
  check("token refresh rotation", body.success === true && body.data.accessToken, body);
  r = await j("POST", "/api/auth/refresh", { refreshToken: u1.refreshToken });
  body = await r.json();
  check("old refresh token revoked", body.success === false, body);

  // 18. identity + ledger immutability
  try {
    await db.query(`UPDATE users SET national_id = '999999999' WHERE id = $1`, [reg1.data.userId]);
    check("identity immutable in DB", false, "update unexpectedly succeeded");
  } catch (e) {
    check("identity immutable in DB", String(e.message).includes("immutable") || String(e.message).includes("IDENTITY LOCKED"), e.message);
  }
  try {
    await db.query(`UPDATE audit_ledger SET amount_minor = 1 WHERE id = 1`);
    check("ledger immutable", false, "update unexpectedly succeeded");
  } catch (e) {
    check("ledger immutable", true, e.message);
  }

  // 19. concurrency: parallel QR settlement correctness
  const results = await Promise.all(
    Array.from({ length: 10 }, () => j("POST", "/api/qr", { amount: "1.00", currency: "ILS" }, u2.accessToken)
      .then(res => res.json()))
  );
  const payloads = results.filter(x => x.success).map(x => x.data.payload);
  const execs = await Promise.all(
    payloads.map(p => j("POST", "/api/transactions/qr", { payload: p, biometricConfirmed: true }, u1.accessToken, { "x-biometric-confirmed": "true" }).then(res => res.json()))
  );
  const okCount = execs.filter(x => x.success).length;
  const lastOk = execs.filter(x => x.success).pop();
  const expectedFinal = 464500 - (okCount - 3) * 100 - 250; // p2p & fakka already moved it; recompute below
  r = await j("GET", "/api/wallets", undefined, u1.accessToken);
  body = await r.json();
  const ilsNow = body.data.find(w => w.currency === "ILS");
  const finalOk = (await j("GET", "/api/ledger?currency=ILS&limit=100", undefined, u1.accessToken)).json();
  check("concurrent settlements all succeed atomically", okCount === payloads.length, { okCount, total: payloads.length });
  // verify ledger integrity: last credit balance matches wallet balance
  const ledgerBody = (await (await j("GET", "/api/ledger?currency=ILS&limit=100", undefined, u1.accessToken)).json());
  const credits = ledgerBody.data.items.filter(i => i.direction === "credit");
  const latest = ledgerBody.data.items[0];
  check("wallet balance equals latest ledger balance_after", latest && parseInt(latest.balanceAfter) === parseInt(ilsNow.balanceMinor), { ledger: latest && latest.balanceAfter, wallet: ilsNow && ilsNow.balanceMinor });

  console.log(`\n========== RESULT: ${passed} passed, ${failed} failed ==========`);
  await pg.stop();
  process.exit(failed > 0 ? 1 : 0);

  async function waitForServer() {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (res.ok) return;
      } catch (e) {}
      await sleep(500);
    }
    throw new Error("server did not become healthy");
  }
}

main().catch((e) => {
  console.error("E2E FATAL:", e);
  process.exit(1);
});
