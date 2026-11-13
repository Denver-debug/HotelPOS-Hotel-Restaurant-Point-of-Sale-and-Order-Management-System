// Login, logout, lockout and employee verification against HR.
import bcrypt from "bcrypt";
import { User, Role } from "../models/index.js";
import { config } from "../config/env.js";
import { AppError } from "../utils/http.js";
import { audit } from "./auditService.js";
import { getHrGateway } from "../integrations/hr/hrGateway.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const BCRYPT_ROUNDS = 12;
export const MIN_PASSWORD_LENGTH = 8;

export async function verifyEmployee(employeeId, { userId } = {}) {
  const hr = getHrGateway();
  return logged(
    { system: "HR", operation: "getEmployee", isMock: hr.isMock, referenceType: "employee", referenceId: employeeId, request: { employeeId }, userId },
    () => hr.getEmployee(employeeId)
  );
}

let dummyHash;

const regenerate =(req) => new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));

export async function login(req, username, password) {
  const invalid = new AppError("Invalid username or password.", 401, "INVALID_CREDENTIALS");
  const user = await User.scope("withPassword").findOne({ where: { username }, include: [{ model: Role, as: "role" }] });

  if (!user) {
    dummyHash ??= await bcrypt.hash("timing-equalizer", BCRYPT_ROUNDS);
    await bcrypt.compare(password, dummyHash); // keep response time similar for unknown users
    await audit({ req, action: "LOGIN_FAILED", entityType: "user", newValues: { username, reason: "unknown user" } });
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ req, userId: user.id, action: "LOGIN_BLOCKED", entityType: "user", entityId: user.id, newValues: { reason: "locked" } });
    throw new AppError(`Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`, 423, "LOCKED");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS;
    await user.update({
      failedLoginCount: lock ? 0 : failed,
      lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : user.lockedUntil,
    });
    await audit({ req, userId: user.id, action: "LOGIN_FAILED", entityType: "user", entityId: user.id, newValues: { attempts: failed, locked: lock } });
    throw invalid;
  }
  if (user.isServiceAccount) {
    // API service accounts authenticate with their API key only.
    await audit({ req, userId: user.id, action: "LOGIN_BLOCKED", entityType: "user", entityId: user.id, newValues: { reason: "service account" } });
    throw invalid;
  }
  if (user.status !== "ACTIVE") {
    await audit({ req, userId: user.id, action: "LOGIN_BLOCKED", entityType: "user", entityId: user.id, newValues: { reason: user.status } });
    throw new AppError("This account is not active. Contact your system administrator.", 403, "INACTIVE");
  }

  // DFD 1.0 / Use case "Authenticate Employee with HR and Staff Payroll"
  if (config.integrations.hr.validateOnLogin && user.externalEmployeeId) {
    try {
      const employee = await verifyEmployee(user.externalEmployeeId, { userId: user.id });
      if (!employee.found || !employee.active) {
        await audit({ req, userId: user.id, action: "LOGIN_BLOCKED", entityType: "user", entityId: user.id, newValues: { reason: "HR employee not active" } });
        throw new AppError("HR reports that this employee is not active. Contact HR or your administrator.", 403, "HR_INACTIVE");
      }
    } catch (err) {
      if (!(err instanceof IntegrationError)) throw err;
      // HR unavailable: allow sign-in so outlets keep operating, but record it.
      await audit({ req, userId: user.id, action: "HR_CHECK_UNAVAILABLE", entityType: "user", entityId: user.id, newValues: { error: err.message } });
    }
  }

  await regenerate(req);
  req.session.userId = user.id;
  await user.update({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });
  await audit({ req, userId: user.id, action: "LOGIN", entityType: "user", entityId: user.id });
  return user;
}

export async function logout(req) {
  if (req.user) await audit({ req, action: "LOGOUT", entityType: "user", entityId: req.user.id });
  await new Promise((resolve) => req.session.destroy(() => resolve()));
}

export const validatePasswordStrength = (password) => {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 422, "WEAK_PASSWORD");
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AppError("Password must contain both letters and numbers.", 422, "WEAK_PASSWORD");
  }
};

export async function changePassword(req, currentPassword, newPassword, confirmPassword) {
  const user = await User.scope("withPassword").findByPk(req.user.id);
  if (!(await bcrypt.compare(currentPassword || "", user.passwordHash))) {
    throw new AppError("Your current password is incorrect.", 422, "INVALID_PASSWORD");
  }
  if (newPassword !== confirmPassword) throw new AppError("The new passwords do not match.", 422);
  validatePasswordStrength(newPassword);
  await user.update({ passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS), passwordChangedAt: new Date() });
  await audit({ req, action: "PASSWORD_CHANGED", entityType: "user", entityId: user.id });
}

// Re-authenticates a supervisor at the terminal (void / discount / refund overrides).
export async function authorizeSupervisor(req, username, password, permission) {
  const user = await User.scope("withPassword").findOne({
    where: { username: String(username || "").trim() },
    include: [{ model: Role, as: "role", include: ["permissions"] }],
  });
  const ok = user && user.status === "ACTIVE" && (await bcrypt.compare(password || "", user.passwordHash));
  const allowed = ok && user.role.permissions.some((p) => p.code === permission);
  await audit({
    req,
    action: allowed ? "SUPERVISOR_OVERRIDE" : "SUPERVISOR_OVERRIDE_FAILED",
    entityType: "user",
    entityId: user?.id ?? null,
    newValues: { permission, supervisor: String(username || "") },
  });
  if (!allowed) throw new AppError("Supervisor authorization failed: invalid credentials or insufficient permission.", 403, "OVERRIDE_DENIED");
  return { id: user.id, username: user.username, fullName: user.fullName };
}
