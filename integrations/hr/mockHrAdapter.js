// MOCK HR adapter for local development. It does NOT contact a real HR system.
// Codes follow StaffPay's employee codes (EMP001, EMP002, ...).
const EMPLOYEES = {
  EMP012: { fullName: "Miguel Ramirez", active: true, position: "Bartender" },
  EMP010: { fullName: "Carlo Fernandez", active: true, position: "F&B Supervisor" },
  EMP013: { fullName: "Antonio Gonzales", active: true, position: "Executive Chef" },
  EMP011: { fullName: "Jasmine Tan", active: true, position: "Waiter / Waitress" },
  EMP014: { fullName: "Rosa Pascual", active: true, position: "Line Cook" },
  EMP001: { fullName: "Andrea Reyes", active: true, position: "HR & Payroll Officer" },
  EMP999: { fullName: "Separated Employee", active: false, position: "Former staff" },
};

export class MockHrAdapter {
  name = "MockHrAdapter";
  isMock = true;

  async getEmployee(employeeId) {
    const id = String(employeeId || "").toUpperCase();
    const emp = EMPLOYEES[id];
    // Any other well-formed EMP### code is treated as an active employee so admins can
    // create accounts freely during development.
    if (!emp && /^EMP\d{3,}$/.test(id)) return { found: true, employeeId: id, fullName: null, active: true };
    if (!emp) return { found: false, employeeId: id, active: false };
    return { found: true, employeeId: id, ...emp };
  }
}
