// The original XianFire scaffold could create a `Users` table via sequelize.sync().
// On Windows (lower_case_table_names=1) it collides with the new `users` table, so
// preserve any such table and its data under a different name instead of dropping it.
export async function up(conn, { log }) {
  const [cols] = await conn.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'"
  );
  if (cols.length === 0 || cols.some((c) => c.name === "password_hash")) return;

  const [[table]] = await conn.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'"
  );
  await conn.query(`RENAME TABLE \`${table.name}\` TO legacy_users_backup`);
  log("ℹ️  Renamed scaffold users table to legacy_users_backup (data preserved).");
}
