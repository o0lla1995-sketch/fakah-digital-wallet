-- 01_users.sql — users, identity constraints + immutability protection
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL   PRIMARY KEY,
  full_name       VARCHAR(120) NOT NULL,
  national_id     VARCHAR(9)   NOT NULL,
  phone           VARCHAR(10)  NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  kyc_status      kyc_status  NOT NULL DEFAULT 'pending',
  role            user_role   NOT NULL DEFAULT 'user',
  failed_attempts SMALLINT     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT users_national_id_format CHECK (national_id ~ '^[0-9]{9}$'),
  CONSTRAINT users_phone_format       CHECK (phone ~ '^(056|059)[0-9]{7}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_national_id ON users (national_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone       ON users (phone);
CREATE INDEX IF NOT EXISTS ix_users_kyc_status         ON users (kyc_status);

-- refresh tokens (hashed)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         BIGSERIAL  PRIMARY KEY,
  user_id    BIGINT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  user_agent VARCHAR(200),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens (user_id);

-- identity immutability trigger
CREATE OR REPLACE FUNCTION fn_protect_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.national_id <> OLD.national_id
     OR NEW.full_name  <> OLD.full_name THEN
    IF current_setting('app.allow_identity_edit', true)
       IS DISTINCT FROM 'admin_override' THEN
      RAISE EXCEPTION
        'IDENTITY LOCKED: national_id/full_name are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_users_protect_identity ON users;
CREATE TRIGGER trg_users_protect_identity
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION fn_protect_identity();

-- admin audit log
CREATE TABLE IF NOT EXISTS admin_audit (
  id         BIGSERIAL  PRIMARY KEY,
  admin_id   BIGINT     NOT NULL REFERENCES users(id),
  action     VARCHAR(60) NOT NULL,
  target_user BIGINT    REFERENCES users(id),
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
