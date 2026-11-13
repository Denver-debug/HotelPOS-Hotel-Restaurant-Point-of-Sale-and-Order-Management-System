// ERP integration API (/api/v1):
//  - api_clients: API keys for other ERP subsystems. Each key acts as a service-account user,
//    so the existing roles, outlet assignments, created_by columns and audit log apply as-is.
//  - users.is_service_account: such accounts can never sign in to the web UI.
//  - orders.idempotency_key / external_reference: safe retries and the caller's own order id.
//  - updated_at indexes for incremental sync (?updatedSince=).
//  - the read-only ERP_INTEGRATION role (also kept in config/permissions.js for seeding).
import { ROLES } from "../../config/permissions.js";

const exists = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;
const hasColumn = (conn, table, column) =>
  exists(conn, "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, column]);
const hasIndex = (conn, table, index) =>
  exists(conn, "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [table, index]);

export async function up(conn, { log }) {
  await conn.query(`CREATE TABLE IF NOT EXISTS api_clients (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    key_prefix CHAR(8) NOT NULL COMMENT 'public part of the key, used to look it up',
    key_hash CHAR(64) NOT NULL COMMENT 'SHA-256 of the full key; the key itself is shown once',
    user_id INT UNSIGNED NOT NULL COMMENT 'service account the key acts as',
    allowed_ips VARCHAR(500) NULL COMMENT 'comma-separated client IPs; NULL = any',
    status ENUM('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
    last_used_at DATETIME NULL,
    last_used_ip VARCHAR(45) NULL,
    created_by INT UNSIGNED NULL,
    revoked_by INT UNSIGNED NULL,
    revoked_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_api_clients_prefix (key_prefix),
    UNIQUE KEY uq_api_clients_user (user_id),
    CONSTRAINT fk_api_clients_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_api_clients_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_api_clients_revoker FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  if (!(await hasColumn(conn, "users", "is_service_account"))) {
    await conn.query("ALTER TABLE users ADD COLUMN is_service_account TINYINT(1) NOT NULL DEFAULT 0 AFTER status");
  }

  if (!(await hasColumn(conn, "orders", "idempotency_key"))) {
    await conn.query(`ALTER TABLE orders
      ADD COLUMN idempotency_key VARCHAR(100) NULL AFTER notes,
      ADD COLUMN external_reference VARCHAR(100) NULL COMMENT 'order id in the calling system' AFTER idempotency_key,
      ADD UNIQUE KEY uq_orders_idempotency (idempotency_key),
      ADD KEY idx_orders_external_reference (external_reference)`);
  }

  // Incremental sync reads "updated since T, oldest first".
  for (const table of ["orders", "payments", "guest_charges", "refunds", "shifts", "products", "categories", "outlets", "stock_levels"]) {
    const index = `idx_${table}_updated_at`;
    if (!(await hasIndex(conn, table, index))) await conn.query(`ALTER TABLE ${table} ADD KEY ${index} (updated_at, id)`);
  }

  // Role for ERP subsystems (accounting, BI, inventory planning): read-only by default.
  const role = ROLES.ERP_INTEGRATION;
  await conn.query(
    "INSERT INTO roles (code, name, description, is_system) VALUES ('ERP_INTEGRATION', ?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)",
    [role.name, role.description]
  );
  const [[{ id: roleId }]] = await conn.query("SELECT id FROM roles WHERE code = 'ERP_INTEGRATION'");
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?", [roleId]);
  if (Number(n) === 0) {
    // On a brand-new database the permissions are seeded after migrations; the seed grants them.
    const [perms] = await conn.query("SELECT id, code FROM permissions");
    const byCode = new Map(perms.map((p) => [p.code, p.id]));
    for (const code of role.permissions) {
      if (byCode.has(code)) await conn.query("INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [roleId, byCode.get(code)]);
    }
  }
  log("ℹ️  Added API clients, service accounts and the ERP_INTEGRATION role.");
}
