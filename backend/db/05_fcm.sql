-- 05_fcm.sql — device push tokens
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        VARCHAR(255) NOT NULL,
  device_info  VARCHAR(160),
  active       BOOLEAN     NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_fcm_token UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS ix_fcm_user ON fcm_tokens (user_id) WHERE active;

-- 07_jobs.sql — statements generation jobs (in statement_jobs table)
CREATE TABLE IF NOT EXISTS statement_jobs (
  id          BIGSERIAL  PRIMARY KEY,
  user_id     BIGINT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_date   DATE       NOT NULL,
  to_date     DATE       NOT NULL,
  currencies  VARCHAR(30) NOT NULL DEFAULT 'ILS,USD,JOD',
  status      job_status NOT NULL DEFAULT 'queued',
  file_key    VARCHAR(200),
  file_sha256 VARCHAR(64),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_jobs_user ON statement_jobs (user_id, id DESC);

-- migrations tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id         SERIAL PRIMARY KEY,
  filename   VARCHAR(120) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
