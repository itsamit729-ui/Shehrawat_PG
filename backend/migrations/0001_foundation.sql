-- Identity, audit and durable infrastructure.
-- MySQL DDL is not transactional: keep each migration expand-only and safe to finish by hand.

CREATE TABLE businesses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_businesses_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('owner', 'resident', 'corporate') NOT NULL,
  status ENUM('invited', 'active', 'disabled') NOT NULL DEFAULT 'invited',
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(16) NULL,
  password_hash VARCHAR(255) NULL,
  last_login_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  -- MySQL has no partial unique index. NULL for non-owners, so only one owner per business can exist.
  owner_guard CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (IF(role = 'owner', business_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (business_id, email),
  UNIQUE KEY uq_users_phone (business_id, phone),
  UNIQUE KEY uq_users_single_owner (owner_guard),
  CONSTRAINT fk_users_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The primary key is a hash, so a database read does not reveal usable session tokens.
CREATE TABLE sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  last_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  idle_expires_at DATETIME(6) NOT NULL,
  absolute_expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_absolute_expiry (absolute_expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE otp_challenges (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hmac CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  invalidated_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY ix_otp_user_created (user_id, created_at),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_tokens (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose ENUM('invite', 'recovery') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  expires_at DATETIME(6) NOT NULL,
  used_at DATETIME(6) NULL,
  PRIMARY KEY (token_hash),
  KEY ix_password_tokens_user (user_id, used_at),
  KEY ix_password_tokens_expiry (expires_at),
  CONSTRAINT fk_password_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Durable quotas, so a restart or a second instance cannot reset them.
CREATE TABLE rate_limits (
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_started_at DATETIME(6) NOT NULL,
  window_seconds INT UNSIGNED NOT NULL,
  hits INT UNSIGNED NOT NULL,
  PRIMARY KEY (key_hash),
  KEY ix_rate_limits_window (window_started_at)
) ENGINE=InnoDB;

CREATE TABLE audit_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NULL,
  request_id VARCHAR(64) NULL,
  metadata JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_audit_entity (business_id, entity_type, entity_id, created_at),
  CONSTRAINT fk_audit_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB;

CREATE TABLE idempotency_keys (
  actor VARCHAR(64) NOT NULL,
  endpoint VARCHAR(64) NOT NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (actor, endpoint, idempotency_key),
  KEY ix_idempotency_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(64) NOT NULL,
  dedupe_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  state ENUM('queued', 'running', 'done', 'dead') NOT NULL DEFAULT 'queued',
  run_at DATETIME(6) NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  lease_expires_at DATETIME(6) NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_dedupe (kind, dedupe_key),
  KEY ix_jobs_due (state, run_at),
  KEY ix_jobs_lease (state, lease_expires_at)
) ENGINE=InnoDB;
