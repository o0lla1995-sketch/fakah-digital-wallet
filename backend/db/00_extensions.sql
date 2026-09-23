-- 00_extensions.sql — extensions + enum types (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'currency_code') THEN
    CREATE TYPE currency_code AS ENUM ('ILS', 'USD', 'JOD');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'kyc_status') THEN
    CREATE TYPE kyc_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('user', 'admin');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'tx_direction') THEN
    CREATE TYPE tx_direction AS ENUM ('debit', 'credit');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'tx_type') THEN
    CREATE TYPE tx_type AS ENUM ('fakka_deposit', 'qr_payment', 'p2p_transfer', 'fx_conversion');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'kyc_doc_type') THEN
    CREATE TYPE kyc_doc_type AS ENUM ('id_front', 'id_back', 'selfie');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'done', 'failed');
  END IF;
END $$;
