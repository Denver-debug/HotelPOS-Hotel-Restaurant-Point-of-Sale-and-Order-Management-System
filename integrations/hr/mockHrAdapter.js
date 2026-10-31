// MOCK HR adapter for local development. It does NOT contact a real HR system.
const EMPLOYEES = {
  "EMP-0231": { fullName: "Cashier One", active: true, position: "Cashier" },
  "EMP-0102": { fullName: "Outlet Supervisor", active: true, position: "F&B Supervisor" },
  "EMP-0007": { fullName: "POS Manager", active: true, position: "F&B Manager" },
  "EMP-0310": { fullName: "Restaurant Staff", active: true, position: "Waiter" },
  "EMP-0405": { fullName: "Inventory Staff", active: true, position: "Storekeeper" },
  "EMP-0050": { fullName: "Accounting Staff", active: true, position: "Accountant" },
  "EMP-9999": { fullName: "Separated Employee", active: false, position: "Former staff" },
};

export class MockHrAdapter {
  name = "MockHrAdapter";
  isMock = true;

  async getEmployee(employeeId) {
    const id = String(employeeId || "").toUpperCase();
    const emp = EMPLOYEES[id];
    // Any other well-formed EMP-#### id is treated as an active employee so admins can
    // create accounts freely during development.
    if (!emp && /^EMP-\d{4}$/.test(id)) return { found: true, employeeId: id, fullName: null, active: true };
    if (!emp) return { found: false, employeeId: id, active: false };
    return { found: true, employeeId: id, ...emp };
  }
}
