# Fakah — Digital Change Wallet (الفكة الرقمية)

A complete FinTech system that solves the **"Fakka" (small change) problem** in the Palestinian market by turning physical change into instantly-transferable digital balances between customers and merchants.

## What's inside

| Part | Tech | Notes |
|------|------|-------|
| `backend/` | Node.js + TypeScript + Express + PostgreSQL | Atomic PL/pgSQL settlement engine, multi-currency (ILS/USD/JOD), KYC workflow, FCM push, Arabic PDF statements, WebSocket live channel |
| `android/` | Kotlin (Native) + MVVM + Clean Architecture | BiometricPrompt gate, ZXing QR (generate + scan), Android Keystore session vault, FLAG_SECURE, SSL Pinning |
| Architecture study | see `docs/` | Full Arabic architectural study (DOCX) with SQL, PL/pgSQL, diagrams |

## Key guarantees

- **Atomicity** — every financial operation runs inside one PL/pgSQL function call (row locks in ascending id order → deadlock-free, double-spend-proof).
- **Immutable ledger** — `audit_ledger` is append-only (REVOKE + trigger); every entry stores balance-before/balance-after and a shared `tx_uuid` per double-entry pair.
- **Single-use QR** — HMAC-signed payload (60s TTL) + one-time nonce consumed inside the settlement transaction itself.
- **Identity lock** — `national_id`/`full_name` are immutable at the DB level (regex + unique constraints + trigger; admin override path only).
- **Money as integers** — all balances are BIGINT minor units (agora/cents/fils); FX conversion uses exact NUMERIC math with banker's-safe rounding.

## Quick start (backend)

```bash
cd backend
cp .env.example .env         # fill secrets
npm install && npm run build
npm start                    # migrations auto-apply on boot
```

End-to-end test suite (embedded PostgreSQL, 34 checks):

```bash
npm install -D embedded-postgres @embedded-postgres/linux-x64
node test/run-e2e.js
```

## Quick start (android)

Open `android/` in Android Studio, or build from CLI:

```bash
cd android
./gradlew assembleRelease -PFAKAH_API_URL=https://your-api-domain \
     -PFAKAH_SSL_PINS="sha256/XXXX,sha256/YYYY"
```

`google-services.json` (Firebase) is optional — push notifications activate once it is added; the app falls back to WebSocket + pull refresh without it.

## Deployment (Coolify)

1. Provision a PostgreSQL service, link it to the app, `DATABASE_URL` is injected.
2. Deploy `backend/` from this repo (Dockerfile included, port 8080, `/healthz` healthcheck).
3. Set env vars from `.env.example` (all secrets live in Coolify, never in git).

## Security notice

Keystore, `.env`, and Firebase service accounts are **never** committed. Rotate any credential that was shared over chat.
