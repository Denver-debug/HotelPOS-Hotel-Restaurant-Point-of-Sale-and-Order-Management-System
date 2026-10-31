// Usage:
//   npm run migrate                    apply pending migrations
//   npm run migrate -- --seed          apply migrations and seed reference data
//   npm run migrate -- --seed --demo   also seed demo cashier/supervisor/manager accounts
//   npm run migrate -- --fresh --yes   DROP and rebuild the database (development only)
import { config } from "./config/env.js";
import { migrate } from "./database/migrator.js";

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");

if (fresh && (config.isProduction || !args.includes("--yes"))) {
  console.error("❌ --fresh drops the whole database. Re-run with --fresh --yes (never in production).");
  process.exit(1);
}

try {
  await migrate({ seed: args.includes("--seed"), demo: args.includes("--demo"), fresh });
  process.exit(0);
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
}
