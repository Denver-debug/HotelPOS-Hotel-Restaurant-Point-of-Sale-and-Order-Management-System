// Adapter for StaffPay, the hotel's HR and Staff Payroll system (e.g. https://staffpay.ecomap.site).
// StaffPay owns the employee master data; HotelPOS only asks whether an employee exists and is
// still employed, when a POS user is created and at sign-in. The endpoint it calls is specified
// for the StaffPay team in docs/STAFFPAY-API.md:
//   GET /employees/{employee_code}   Authorization: Bearer <HR_API_KEY>
// HR_BASE_URL is https://<staffpay-host>/api/v1.
//
// POS users' Employee IDs are StaffPay employee codes (EMP001, ...), sent exactly as stored.
import { requestJson } from "../httpClient.js";
import { IntegrationError } from "../integrationLogger.js";

// StaffPay's ACTIVE_STATUSES: still employed, so allowed to work the POS.
export const STAFFPAY_ACTIVE_STATUSES = ["active", "probationary", "on_leave"];

export class StaffPayHrAdapter {
  name = "StaffPayHrAdapter";
  isMock = false;

  constructor(cfg) {
    this.cfg = cfg;
  }

  async getEmployee(employeeId) {
    const res = await requestJson({ ...this.cfg, path: `employees/${encodeURIComponent(employeeId)}` });
    if (res.httpStatus === 404) return { found: false, employeeId, active: false, httpStatus: 404 };
    if (!res.ok) {
      const e = res.data?.error || {};
      const reason = res.httpStatus === 401 || res.httpStatus === 403 ? "StaffPay refused the API key (check HR_API_KEY)." : e.message || `StaffPay returned HTTP ${res.httpStatus}.`;
      throw new IntegrationError("REJECTED", `${reason}${e.code ? ` (${e.code})` : ""}`, { httpStatus: res.httpStatus, response: res.data });
    }
    // { success: true, data: {...} } as specified; a bare object is accepted too.
    const d = res.data?.data ?? res.data ?? {};
    if (!d.employee_code && !d.employment_status && typeof d.active !== "boolean") {
      throw new IntegrationError("INVALID_RESPONSE", "StaffPay response has no employee fields.", { httpStatus: res.httpStatus, response: res.data });
    }
    const status = d.employment_status ? String(d.employment_status).toLowerCase() : null;
    return {
      found: true,
      employeeId,
      hrEmployeeCode: d.employee_code ?? null,
      fullName: d.full_name ?? null,
      active: typeof d.active === "boolean" ? d.active : STAFFPAY_ACTIVE_STATUSES.includes(status),
      employmentStatus: status,
      position: d.position ?? null,
      department: d.department ?? null,
      httpStatus: res.httpStatus,
    };
  }
}
