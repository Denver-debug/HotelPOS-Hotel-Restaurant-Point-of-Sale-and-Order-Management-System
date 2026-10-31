-- Infrastructure tables: HTTP sessions and document number sequences.

CREATE TABLE sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  data MEDIUMTEXT NOT NULL,
  expires BIGINT NOT NULL,
  INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-period counters for ORD-YYYYMMDD-0001 style numbers (row-locked on use).
CREATE TABLE document_sequences (
  name VARCHAR(30) NOT NULL,
  period VARCHAR(10) NOT NULL,
  current_value INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (name, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
