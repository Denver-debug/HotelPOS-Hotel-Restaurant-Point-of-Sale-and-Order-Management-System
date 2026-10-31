// Tiny JSON-file ledger used by the mock adapters to remember transactions by
// idempotency key across restarts (storage/ is git-ignored). Never used by real adapters.
import fs from "fs";
import path from "path";
import { config } from "../config/env.js";

export class MockLedger {
  constructor(name) {
    this.file = path.join(config.rootDir, "storage", `${config.isTest ? "test-" : ""}${name}.json`);
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return value;
  }

  values() {
    return Object.values(this.data);
  }

  reset() {
    this.data = {};
    fs.rmSync(this.file, { force: true });
  }
}
