// POS users' employee IDs are StaffPay employee codes (EMP001, EMP002, ...). The demo users
// seeded before used EMP-####; move them to the StaffPay employees with the closest job.
// IDs an administrator typed in are left alone: edit them under Users.
const DEMO_CODES = [
  ["EMP-0231", "EMP012"], // cashier01     → Miguel Ramirez, Bartender
  ["EMP-0102", "EMP010"], // supervisor01  → Carlo Fernandez, F&B Supervisor
  ["EMP-0007", "EMP013"], // manager01     → Antonio Gonzales, Executive Chef
  ["EMP-0310", "EMP011"], // staff01       → Jasmine Tan, Waiter / Waitress
  ["EMP-0405", "EMP014"], // inventory01   → Rosa Pascual, Line Cook
  ["EMP-0050", "EMP001"], // accountant01  → Andrea Reyes, HR & Payroll Officer
];

export async function up(conn, { log }) {
  let moved = 0;
  for (const [from, to] of DEMO_CODES) {
    const [[taken]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE external_employee_id = ?", [to]);
    if (taken.n) continue;
    const [res] = await conn.query("UPDATE users SET external_employee_id = ? WHERE external_employee_id = ?", [to, from]);
    moved += res.affectedRows;
  }
  const [[other]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE external_employee_id IS NOT NULL AND external_employee_id NOT REGEXP '^EMP[0-9]{3,}$'");
  log(`ℹ️  ${moved} demo user(s) now use StaffPay employee codes.${other.n ? ` ${other.n} user(s) still have another Employee ID format; change them to StaffPay codes under Users.` : ""}`);
}
