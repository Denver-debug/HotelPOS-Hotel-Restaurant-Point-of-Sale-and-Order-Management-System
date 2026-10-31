// HTTP adapter for the HR and Staff Payroll API.
// NOTE: the HR API contract is not yet published; the endpoint below
// (GET /employees/{id}) is an assumption to be confirmed with the HR subsystem team.
import { requestJson } from "../httpClient.js";
import { IntegrationError } from "../integrationLogger.js";

export class HttpHrAdapter {
  name = "HttpHrAdapter";
  isMock = false;

  constructor(cfg) {
    this.cfg = cfg;
  }

  async getEmployee(employeeId) {
    const res = await requestJson({ ...this.cfg, path: `employees/${encodeURIComponent(employeeId)}` });
    if (res.httpStatus === 404) return { found: false, employeeId, active: false };
    if (!res.ok) throw new IntegrationError("REJECTED", `HR returned HTTP ${res.httpStatus}.`, { httpStatus: res.httpStatus, response: res.data });
    const d = res.data || {};
    return {
      found: true,
      employeeId,
      fullName: d.fullName ?? d.name ?? null,
      active: d.active ?? d.status === "ACTIVE",
      position: d.position ?? null,
      httpStatus: res.httpStatus,
    };
  }
}
