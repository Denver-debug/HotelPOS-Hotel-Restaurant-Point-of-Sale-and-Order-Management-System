// Generates human-readable document numbers (ORD-20261030-0042, RCPT-…, SH-…).
// Uses a row-locked counter per document type and business day.
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { businessDateKey } from "../utils/dates.js";

const FORMATS = {
  order: { prefix: "ORD", width: 4 },
  receipt: { prefix: "RCPT", width: 4 },
  shift: { prefix: "SH", width: 2 },
  payment: { prefix: "PAY", width: 4 },
  guestCharge: { prefix: "GC", width: 4 },
  refund: { prefix: "RF", width: 4 },
  inventory: { prefix: "ITX", width: 5 },
};

async function nextValue(name, period, transaction) {
  await sequelize.query(
    `INSERT INTO document_sequences (name, period, current_value) VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)`,
    { replacements: [name, period], transaction }
  );
  const [row] = await sequelize.query("SELECT LAST_INSERT_ID() AS value", { type: QueryTypes.SELECT, transaction });
  return Number(row.value);
}

export async function nextNumber(type, transaction) {
  const format = FORMATS[type];
  if (!format) throw new Error(`Unknown document type: ${type}`);
  const period = businessDateKey();
  // LAST_INSERT_ID is per-connection, so both statements must share one connection.
  const value = transaction
    ? await nextValue(type, period, transaction)
    : await sequelize.transaction((t) => nextValue(type, period, t));
  return `${format.prefix}-${period}-${String(value).padStart(format.width, "0")}`;
}
