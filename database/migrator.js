// Versioned migration runner. Applies database/migrations/* in order (once each),
// tracked in `schema_migrations`. Migrations may be .sql files or .js modules
// exporting `up(connection)`. Seeds are idempotent and run with { seed: true }.
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import mysql from "mysql2/promise";
import { config } from "../config/env.js";

const migrationsDir = path.join(config.rootDir, "database", "migrations");

export const connect = (withDatabase = true) =>
  mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: withDatabase ? config.db.name : undefined,
    multipleStatements: true,
    timezone: config.timezone,
    decimalNumbers: false,
  });

export async function migrate({ seed = false, fresh = false, demo = false, log = console.log } = {}) {
  const server = await connect(false);
  try {
    if (fresh) {
      log(`⚠️  Dropping database \`${config.db.name}\``);
      await server.query(`DROP DATABASE IF EXISTS \`${config.db.name}\``);
    }
    await server.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await server.end();
  }

  const conn = await connect(true);
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    const [rows] = await conn.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const files = (await fs.readdir(migrationsDir)).filter((f) => /\.(sql|js)$/.test(f)).sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.(sql|js)$/, "");
      if (applied.has(version)) continue;
      const fullPath = path.join(migrationsDir, file);
      if (file.endsWith(".sql")) {
        await conn.query(await fs.readFile(fullPath, "utf8"));
      } else {
        const mod = await import(pathToFileURL(fullPath).href);
        await mod.up(conn, { log });
      }
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      log(`✅ Applied migration ${version}`);
      count++;
    }
    if (count === 0) log("ℹ️  Database schema is up to date.");

    if (seed) {
      const { runSeeds } = await import("./seeds/seed.js");
      await runSeeds(conn, { demo, log });
    }
  } finally {
    await conn.end();
  }
}
