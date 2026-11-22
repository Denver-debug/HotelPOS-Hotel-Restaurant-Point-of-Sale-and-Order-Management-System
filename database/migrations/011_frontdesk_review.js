// Frontdesk / PMS review of room charges (PMS_ADAPTER=frontdesk). The Frontdesk queues a POS
// order for a receptionist instead of posting it straight to the folio, so a room charge can be
//  - AWAITING_REVIEW: accepted by the Frontdesk, sale completed, not yet on the guest's folio
//  - REJECTED:        refused by the front desk after the sale; collect payment from the guest
// AWAITING_REVIEW blocks a second charge for the same order, like PENDING / UNKNOWN / POSTED.
const STATUSES = "'PENDING','POSTED','FAILED','UNKNOWN','REVERSED','PARTIALLY_REVERSED','AWAITING_REVIEW','REJECTED'";
const ACTIVE = "'PENDING','UNKNOWN','POSTED','PARTIALLY_REVERSED','AWAITING_REVIEW'";

export async function up(conn, { log }) {
  await conn.query(`ALTER TABLE guest_charges MODIFY status ENUM(${STATUSES}) NOT NULL DEFAULT 'PENDING'`);
  // A generated column's expression is replaced by dropping and re-adding it (MySQL and MariaDB).
  await conn.query("ALTER TABLE guest_charges DROP INDEX uq_guest_charges_one_active, DROP COLUMN active_order_key");
  await conn.query(`ALTER TABLE guest_charges
    ADD COLUMN active_order_key BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status IN (${ACTIVE}), order_id, NULL)) STORED AFTER updated_at,
    ADD UNIQUE KEY uq_guest_charges_one_active (active_order_key)`);
  log("ℹ️  Room charges can now await front-desk review (AWAITING_REVIEW) or be rejected after the sale (REJECTED).");
}
