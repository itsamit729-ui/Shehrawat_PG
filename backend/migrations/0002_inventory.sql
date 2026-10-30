-- Properties, beds, people and the booking records that allocate beds.

CREATE TABLE properties (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  area VARCHAR(160) NOT NULL,
  sector VARCHAR(160) NOT NULL,
  gender VARCHAR(16) NOT NULL,
  audience VARCHAR(64) NOT NULL DEFAULT '',
  food TINYINT(1) NOT NULL DEFAULT 0,
  ac TINYINT(1) NOT NULL DEFAULT 0,
  rating DECIMAL(2, 1) NOT NULL DEFAULT 0,
  reviews INT UNSIGNED NOT NULL DEFAULT 0,
  img VARCHAR(255) NOT NULL DEFAULT '',
  gallery JSON NOT NULL,
  landmarks JSON NOT NULL,
  amenities JSON NOT NULL,
  blurb TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_properties_business (business_id),
  CONSTRAINT fk_properties_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE property_rates (
  property_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sharing ENUM('single', 'double', 'triple') NOT NULL,
  monthly_rent_paise BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (property_id, sharing),
  CONSTRAINT fk_rates_property FOREIGN KEY (property_id) REFERENCES properties (id),
  CONSTRAINT ck_rates_positive CHECK (monthly_rent_paise > 0)
) ENGINE=InnoDB;

CREATE TABLE rooms (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  property_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(32) NOT NULL,
  sharing ENUM('single', 'double', 'triple') NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rooms_code (property_id, code),
  KEY ix_rooms_property_sharing (property_id, sharing),
  CONSTRAINT fk_rooms_property FOREIGN KEY (property_id) REFERENCES properties (id)
) ENGINE=InnoDB;

CREATE TABLE beds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(32) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  blocked TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_beds_code (room_id, code),
  KEY ix_beds_business (business_id),
  CONSTRAINT fk_beds_room FOREIGN KEY (room_id) REFERENCES rooms (id)
) ENGINE=InnoDB;

CREATE TABLE corporate_accounts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_corporates_business (business_id),
  CONSTRAINT fk_corporates_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Access comes from this row, never from matching an email domain.
CREATE TABLE corporate_memberships (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  corporate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (user_id, corporate_id),
  KEY ix_memberships_corporate (corporate_id),
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_corporate FOREIGN KEY (corporate_id) REFERENCES corporate_accounts (id)
) ENGINE=InnoDB;

CREATE TABLE resident_profiles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  corporate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  property_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  room_label VARCHAR(32) NOT NULL,
  monthly_rent_paise BIGINT UNSIGNED NOT NULL,
  status ENUM('Active', 'Notice', 'Moved out') NOT NULL DEFAULT 'Active',
  joined_on DATE NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_resident_user (user_id),
  KEY ix_resident_business (business_id, created_at),
  KEY ix_resident_corporate (corporate_id),
  CONSTRAINT fk_resident_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_resident_corporate FOREIGN KEY (corporate_id) REFERENCES corporate_accounts (id),
  CONSTRAINT fk_resident_property FOREIGN KEY (property_id) REFERENCES properties (id)
) ENGINE=InnoDB;

CREATE TABLE bookings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Empty until a prospect's payment is verified; public holds have no account yet.
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state ENUM('held', 'expired', 'cancelled', 'confirmed', 'payment_review', 'occupied', 'checked_out') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_bookings_resident (resident_id, created_at),
  KEY ix_bookings_business_state (business_id, state),
  CONSTRAINT fk_bookings_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id)
) ENGINE=InnoDB;

CREATE TABLE holds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('active', 'expired', 'cancelled', 'converted') NOT NULL DEFAULT 'active',
  amount_paise BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_holds_state_expiry (state, expires_at),
  KEY ix_holds_booking (booking_id),
  CONSTRAINT fk_holds_booking FOREIGN KEY (booking_id) REFERENCES bookings (id)
) ENGINE=InnoDB;

-- Stays use half-open intervals [stay_start, stay_end); NULL stay_end is an ongoing stay.
-- MySQL has no exclusion constraint, so overlaps are prevented by locking the bed row in
-- src/modules/inventory/allocations.ts. No other code may write to this table.
CREATE TABLE bed_allocations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bed_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hold_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state ENUM('held', 'confirmed', 'occupied', 'released', 'checked_out') NOT NULL,
  -- Copied from the hold, so availability reads can ignore elapsed holds without a join.
  hold_expires_at DATETIME(6) NULL,
  stay_start DATE NOT NULL,
  stay_end DATE NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_allocations_bed_state (bed_id, state, stay_start),
  KEY ix_allocations_booking (booking_id),
  KEY ix_allocations_hold (hold_id),
  CONSTRAINT fk_allocations_bed FOREIGN KEY (bed_id) REFERENCES beds (id),
  CONSTRAINT fk_allocations_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
  CONSTRAINT fk_allocations_hold FOREIGN KEY (hold_id) REFERENCES holds (id),
  CONSTRAINT ck_allocations_range CHECK (stay_end IS NULL OR stay_end > stay_start)
) ENGINE=InnoDB;
