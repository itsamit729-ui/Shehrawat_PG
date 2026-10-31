-- Finance, operations, documents and messaging: blueprint stages 3 to 6.

CREATE TABLE business_settings (
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  settings JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (business_id),
  CONSTRAINT fk_settings_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB;

-- billing_key is a hash of the person billed, the period and the charge type, so retrying a rent
-- run returns the existing invoice, and a resident and their company can't both be charged.
CREATE TABLE invoices (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  corporate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  period CHAR(7) NOT NULL,
  charge_type VARCHAR(32) NOT NULL,
  billing_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description VARCHAR(255) NOT NULL,
  due_on DATE NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  paid_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('Due', 'Part paid', 'Paid', 'Void') NOT NULL DEFAULT 'Due',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_billing_key (business_id, billing_key),
  KEY ix_invoices_resident (resident_id, due_on),
  KEY ix_invoices_corporate (corporate_id, due_on),
  KEY ix_invoices_business_period (business_id, period),
  CONSTRAINT fk_invoices_business FOREIGN KEY (business_id) REFERENCES businesses (id),
  CONSTRAINT fk_invoices_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id),
  CONSTRAINT fk_invoices_corporate FOREIGN KEY (corporate_id) REFERENCES corporate_accounts (id),
  CONSTRAINT ck_invoices_amount CHECK (amount_paise > 0 AND paid_paise <= amount_paise)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Snapshots the charge, so a later change to rates never rewrites an old invoice.
CREATE TABLE invoice_lines (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  invoice_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(32) NOT NULL,
  description VARCHAR(255) NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_invoice_lines_invoice (invoice_id),
  CONSTRAINT fk_invoice_lines_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The intent is saved before the provider is called, so an ambiguous response can be reconciled
-- instead of creating a second payable order. Exactly one of hold_id and invoice_id is set.
CREATE TABLE payment_orders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hold_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  invoice_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status ENUM('pending', 'processing', 'confirmed', 'failed', 'review') NOT NULL DEFAULT 'pending',
  provider_order_id VARCHAR(64) NULL,
  checkout_url VARCHAR(512) NULL,
  customer JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_provider (provider_order_id),
  UNIQUE KEY uq_orders_hold (hold_id),
  KEY ix_orders_invoice (invoice_id),
  KEY ix_orders_status (status, created_at),
  CONSTRAINT fk_orders_business FOREIGN KEY (business_id) REFERENCES businesses (id),
  CONSTRAINT fk_orders_hold FOREIGN KEY (hold_id) REFERENCES holds (id),
  CONSTRAINT fk_orders_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB;

CREATE TABLE payments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source ENUM('razorpay', 'manual') NOT NULL,
  method VARCHAR(32) NOT NULL,
  reference VARCHAR(128) NOT NULL DEFAULT '',
  provider_payment_id VARCHAR(64) NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  state ENUM('captured', 'review') NOT NULL,
  recorded_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_provider (provider_payment_id),
  KEY ix_payments_business (business_id, created_at),
  KEY ix_payments_order (order_id),
  CONSTRAINT fk_payments_business FOREIGN KEY (business_id) REFERENCES businesses (id),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES payment_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_applications (
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  invoice_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (payment_id, invoice_id),
  KEY ix_applications_invoice (invoice_id),
  CONSTRAINT fk_applications_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_applications_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB;

CREATE TABLE refunds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  state ENUM('Pending', 'Refunded', 'Failed', 'Review') NOT NULL DEFAULT 'Pending',
  provider_refund_id VARCHAR(64) NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refunds_provider (provider_refund_id),
  KEY ix_refunds_payment (payment_id),
  CONSTRAINT fk_refunds_payment FOREIGN KEY (payment_id) REFERENCES payments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only. Corrections are new reversing batches, and every batch must balance.
CREATE TABLE ledger_entries (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account VARCHAR(32) NOT NULL,
  debit_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  credit_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source_type VARCHAR(32) NOT NULL,
  source_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_ledger_batch (batch_id),
  KEY ix_ledger_account (business_id, account, created_at),
  KEY ix_ledger_source (source_type, source_id),
  CONSTRAINT fk_ledger_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB;

CREATE TABLE expenses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category VARCHAR(32) NOT NULL,
  description VARCHAR(255) NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  spent_on DATE NOT NULL,
  recorded_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_expenses_business (business_id, spent_on),
  CONSTRAINT fk_expenses_business FOREIGN KEY (business_id) REFERENCES businesses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Persisted before the provider is answered, and de-duplicated by the provider's event ID.
CREATE TABLE webhook_inbox (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(16) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  received_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  processed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_event (provider, event_id),
  KEY ix_webhook_unprocessed (processed_at, received_at)
) ENGINE=InnoDB;

CREATE TABLE tickets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(160) NOT NULL,
  category VARCHAR(64) NOT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'Normal',
  description TEXT NOT NULL,
  status ENUM('Open', 'In progress', 'Resolved') NOT NULL DEFAULT 'Open',
  assignee VARCHAR(64) NOT NULL DEFAULT 'Unassigned',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_tickets_resident (resident_id, created_at),
  KEY ix_tickets_business (business_id, status, created_at),
  CONSTRAINT fk_tickets_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE leads (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  property_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'Enquiry',
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(32) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL DEFAULT '',
  visit_on DATE NULL,
  status ENUM('New', 'Contacted', 'Visit scheduled', 'Converted', 'Closed') NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_leads_business (business_id, status, created_at),
  CONSTRAINT fk_leads_property FOREIGN KEY (property_id) REFERENCES properties (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Referrals, move-out requests and company housing requests. None of them reserves a bed.
CREATE TABLE service_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type ENUM('referrals', 'move-outs', 'housing-requests') NOT NULL,
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  corporate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  details JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Requested',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_requests_business (business_id, type, created_at),
  KEY ix_requests_resident (resident_id),
  KEY ix_requests_corporate (corporate_id),
  CONSTRAINT fk_requests_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id),
  CONSTRAINT fk_requests_corporate FOREIGN KEY (corporate_id) REFERENCES corporate_accounts (id)
) ENGINE=InnoDB;

CREATE TABLE uploads (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  object_key VARCHAR(128) NOT NULL,
  state ENUM('pending', 'validated', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uploads_object (object_key),
  KEY ix_uploads_owner (owner_user_id, created_at),
  CONSTRAINT fk_uploads_user FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE agreements (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(160) NOT NULL,
  status ENUM('Draft', 'Sent', 'Signed', 'Cancelled') NOT NULL DEFAULT 'Draft',
  provider_request_id VARCHAR(128) NULL,
  document_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  signed_upload_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_agreements_provider (provider_request_id),
  KEY ix_agreements_resident (resident_id, created_at),
  KEY ix_agreements_business (business_id, created_at),
  CONSTRAINT fk_agreements_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id),
  CONSTRAINT fk_agreements_upload FOREIGN KEY (signed_upload_id) REFERENCES uploads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Consent is stored with its source and time. A message from someone is not marketing consent.
CREATE TABLE contacts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phone VARCHAR(32) NOT NULL,
  name VARCHAR(160) NOT NULL DEFAULT '',
  resident_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  opt_in_source VARCHAR(64) NULL,
  opted_in_at DATETIME(6) NULL,
  opted_out_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_phone (business_id, phone),
  KEY ix_contacts_resident (resident_id),
  CONSTRAINT fk_contacts_resident FOREIGN KEY (resident_id) REFERENCES resident_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE conversations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contact_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mode ENUM('Bot', 'Human') NOT NULL DEFAULT 'Bot',
  assignee VARCHAR(64) NOT NULL DEFAULT 'Unassigned',
  last_inbound_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversations_contact (contact_id),
  KEY ix_conversations_business (business_id, last_inbound_at),
  CONSTRAINT fk_conversations_contact FOREIGN KEY (contact_id) REFERENCES contacts (id)
) ENGINE=InnoDB;

CREATE TABLE messages (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sender ENUM('customer', 'staff', 'bot') NOT NULL,
  body TEXT NOT NULL,
  provider_message_id VARCHAR(128) NULL,
  status ENUM('queued', 'sent', 'delivered', 'read', 'received', 'failed', 'review') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_provider (provider_message_id),
  KEY ix_messages_conversation (conversation_id, created_at, id),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE campaigns (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  template VARCHAR(128) NOT NULL,
  audience ENUM('Opted-in leads', 'Opted-in residents') NOT NULL,
  scheduled_at DATETIME(6) NOT NULL,
  status ENUM('Draft', 'Scheduled', 'Sending', 'Sent', 'Paused', 'Failed') NOT NULL DEFAULT 'Draft',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY ix_campaigns_business (business_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE campaign_recipients (
  campaign_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contact_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'review') NOT NULL DEFAULT 'queued',
  provider_message_id VARCHAR(128) NULL,
  sent_at DATETIME(6) NULL,
  PRIMARY KEY (campaign_id, contact_id),
  UNIQUE KEY uq_recipients_provider (provider_message_id),
  KEY ix_recipients_state (campaign_id, state),
  KEY ix_recipients_sent (sent_at),
  CONSTRAINT fk_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT fk_recipients_contact FOREIGN KEY (contact_id) REFERENCES contacts (id)
) ENGINE=InnoDB;
