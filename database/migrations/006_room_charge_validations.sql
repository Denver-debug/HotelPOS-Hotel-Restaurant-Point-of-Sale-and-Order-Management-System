-- Single-use proof that the PMS validated a room for an order (step 2 of Charge to Room).
-- Previously kept in the browser session, which meant only the same browser session on the
-- same app instance could post the charge. A database row works for API clients, several
-- app instances and restarts. Only a SHA-256 hash of the token is stored; no guest name.
CREATE TABLE room_charge_validations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  room_number VARCHAR(20) NOT NULL,
  external_room_id VARCHAR(60) NOT NULL,
  external_guest_id VARCHAR(60) NOT NULL,
  external_folio_id VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL COMMENT 'order total when validated',
  order_version INT UNSIGNED NOT NULL COMMENT 'order changed after validation = validate again',
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_room_charge_validations_token (token_hash),
  KEY idx_room_charge_validations_order (order_id),
  KEY idx_room_charge_validations_expiry (expires_at),
  CONSTRAINT fk_room_charge_validations_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_room_charge_validations_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
