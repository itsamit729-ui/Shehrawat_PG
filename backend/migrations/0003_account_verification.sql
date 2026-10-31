ALTER TABLE users ADD COLUMN email_verified_at DATETIME(6) NULL;

-- Every account active so far accepted an emailed invitation, which proved the address.
UPDATE users SET email_verified_at = UTC_TIMESTAMP(6) WHERE status = 'active' AND role <> 'owner';

ALTER TABLE password_tokens MODIFY purpose ENUM('invite', 'recovery', 'verify') NOT NULL;

CREATE TABLE google_identities (
  google_sub VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (google_sub),
  UNIQUE KEY uq_google_user (user_id),
  CONSTRAINT fk_google_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
