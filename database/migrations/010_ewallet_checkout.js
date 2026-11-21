// Hosted e-wallet checkout (PayMongo). A GCash / Maya payment is approved by the guest on
// their own phone, so it stays PENDING while the POS shows the checkout link as a QR code.
//  - payments.provider_reference: the provider's payment intent (pi_…), used to check the
//    status and to match webhooks. payments.external_transaction_id stays the paid payment (pay_…).
//  - payments.checkout_url / checkout_expires_at: the link the guest opens and when it lapses.
//  - With a gateway checkout the provider issues the reference, so the cashier no longer types one.
const hasColumn = async (conn, table, column) =>
  (await conn.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, column]))[0].length > 0;

export async function up(conn, { log }) {
  if (!(await hasColumn(conn, "payments", "provider_reference"))) {
    await conn.query(`ALTER TABLE payments
      ADD COLUMN provider_reference VARCHAR(100) NULL COMMENT 'payment intent at the provider (PayMongo pi_…)' AFTER external_transaction_id,
      ADD COLUMN checkout_url VARCHAR(500) NULL COMMENT 'hosted checkout the guest opens (QR code)' AFTER provider_reference,
      ADD COLUMN checkout_expires_at DATETIME NULL AFTER checkout_url,
      ADD UNIQUE KEY uq_payments_provider_reference (provider_reference)`);
  }
  log("ℹ️  Added the hosted e-wallet checkout columns to payments.");
}
