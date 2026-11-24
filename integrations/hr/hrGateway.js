// HR and Staff Payroll integration contract (DFD process 1.0 "validate employee").
//
// interface HrGateway {
//   name: string; isMock: boolean;
//   getEmployee(employeeId) -> { found: boolean, employeeId, fullName?, active: boolean, position? }
// }
//
// Services obtain the configured adapter through getHrGateway() and never call HR directly.
import { config } from "../../config/env.js";
import { MockHrAdapter } from "./mockHrAdapter.js";
import { HttpHrAdapter } from "./httpHrAdapter.js";
import { StaffPayHrAdapter } from "./staffpayHrAdapter.js";

let instance;

export function getHrGateway() {
  if (!instance) {
    const cfg = config.integrations.hr;
    if (cfg.adapter === "staffpay") instance = new StaffPayHrAdapter(cfg);
    else if (cfg.adapter === "http") instance = new HttpHrAdapter(cfg);
    else instance = new MockHrAdapter();
  }
  return instance;
}

// Test hook: swap the adapter without touching business code.
export function setHrGateway(adapter) {
  instance = adapter;
}
