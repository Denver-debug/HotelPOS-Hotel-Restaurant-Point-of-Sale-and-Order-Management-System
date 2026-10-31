// Test harness: rebuilds HotelPOS_test, starts the real app on a random port and
// provides a cookie/CSRF-aware HTTP client per user.
import fs from "fs";
import path from "path";
import { config } from "../../config/env.js";

export const PASSWORD = "TestPass123";

export async function startApp() {
  if (!config.isTest || !/test/i.test(config.db.name)) throw new Error(`Refusing to run against non-test database ${config.db.name}`);
  for (const f of ["test-mock-pms-ledger.json", "test-mock-payment-ledger.json"]) fs.rmSync(path.join(config.rootDir, "storage", f), { force: true });
  const { migrate } = await import("../../database/migrator.js");
  await migrate({ fresh: true, seed: true, demo: true, log: () => {} });
  const appModule = await import("../../index.js");
  const server = await new Promise((resolve) => {
    const s = appModule.default.listen(0, () => resolve(s));
  });
  const models = await import("../../models/index.js");
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await new Promise((r) => server.close(r));
    appModule.sessionStore.close();
    await models.sequelize.close();
  };
  return { base, models, stop };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, url, { json, form, headers = {}, csrf = true } = {}) {
    const h = { Accept: json !== undefined || method !== "GET" ? "application/json" : "text/html", ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (csrf && this.csrf && method !== "GET") h["X-CSRF-Token"] = this.csrf;
    let body;
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h.Accept = "text/html";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: res.status, location: res.headers.get("location"), text, data };
  }

  get(url) { return this.request("GET", url); }
  post(url, json) { return this.request("POST", url, { json: json ?? {} }); }
  patch(url, json) { return this.request("PATCH", url, { json }); }
  del(url) { return this.request("DELETE", url, { json: {} }); }
  form(url, form) { return this.request("POST", url, { form }); }

  async login(username, password = PASSWORD) {
    const page = await this.get("/login");
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    this.csrf = token;
    const res = await this.request("POST", "/login", { form: { _csrf: token, username, password, next: "" } });
    if (res.status !== 302 || !res.location.endsWith("/dashboard")) throw new Error(`Login failed for ${username}: ${res.status}`);
    await this.refreshCsrf();
    return this;
  }

  async refreshCsrf() {
    const dash = await this.get("/dashboard");
    const m = /name="csrf-token" content="([^"]+)"/.exec(dash.text);
    if (m) this.csrf = m[1];
  }
}

export const uuid = () => crypto.randomUUID();
