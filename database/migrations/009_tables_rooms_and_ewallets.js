// Where an order is served, and the payment methods the hotel accepts.
//  - outlet_tables: each outlet's tables / seats / treatment rooms. The POS picks from this
//    list instead of typing free text; dine-in orders must have one.
//  - orders.outlet_table_id: the table chosen (orders.table_or_location keeps the label as it
//    was at the time, for receipts and history).
//  - orders.room_number: the guest room of a room service / minibar order, checked with the
//    PMS when the order is taken (only the room number is kept, never the guest).
//  - Direct payments are limited to Cash, GCash and Maya. Old methods are deactivated, not
//    deleted, because past payments and refunds point at them.
const exists = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;
const hasColumn = (conn, table, column) =>
  exists(conn, "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, column]);

export async function up(conn, { log }) {
  await conn.query(`CREATE TABLE IF NOT EXISTS outlet_tables (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    outlet_id INT UNSIGNED NOT NULL,
    label VARCHAR(30) NOT NULL COMMENT 'what staff call it: T5, Bar 2, Treatment Room 1',
    area VARCHAR(40) NULL COMMENT 'optional grouping: Patio, Window, Function Room',
    seats SMALLINT UNSIGNED NULL,
    sort_order INT NOT NULL DEFAULT 0,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_outlet_tables_label (outlet_id, label),
    KEY idx_outlet_tables_list (outlet_id, status, sort_order),
    CONSTRAINT fk_outlet_tables_outlet FOREIGN KEY (outlet_id) REFERENCES outlets (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  if (!(await hasColumn(conn, "orders", "outlet_table_id"))) {
    await conn.query(`ALTER TABLE orders
      ADD COLUMN outlet_table_id INT UNSIGNED NULL AFTER table_or_location,
      ADD COLUMN room_number VARCHAR(20) NULL COMMENT 'guest room (room service / minibar), PMS-checked' AFTER outlet_table_id,
      ADD KEY idx_orders_table (outlet_table_id),
      ADD KEY idx_orders_room (room_number, created_at),
      ADD CONSTRAINT fk_orders_table FOREIGN KEY (outlet_table_id) REFERENCES outlet_tables (id)`);
  }

  // On a brand-new database the table is still empty here; the seed inserts the three methods.
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM payment_methods");
  if (Number(n) > 0) {
    await conn.query(
      `INSERT IGNORE INTO payment_methods (code, name, is_cash, uses_gateway, requires_reference, sort_order) VALUES
        ('GCASH', 'GCash', 0, 1, 1, 2),
        ('MAYA', 'Maya', 0, 1, 1, 3)`
    );
    await conn.query("UPDATE payment_methods SET sort_order = 1 WHERE code = 'CASH'");
    await conn.query("UPDATE payment_methods SET status = 'INACTIVE' WHERE code NOT IN ('CASH', 'GCASH', 'MAYA')");
  }
  log("ℹ️  Added outlet tables, order table/room and the GCash and Maya payment methods.");
}
