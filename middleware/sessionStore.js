// express-session store persisted in the MySQL `sessions` table (replaces MemoryStore).
import session from "express-session";
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/db.js";

export class MySQLSessionStore extends session.Store {
  constructor({ ttlMs = 8 * 60 * 60 * 1000, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.cleanup().catch(() => {}), cleanupIntervalMs);
    this.timer.unref?.();
  }

  expiresAt(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpiry || Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    sequelize
      .query("SELECT data FROM sessions WHERE sid = ? AND expires > ?", { replacements: [sid, Date.now()], type: QueryTypes.SELECT })
      .then((rows) => cb(null, rows.length ? JSON.parse(rows[0].data) : null))
      .catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    sequelize
      .query(
        "INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), expires = VALUES(expires)",
        { replacements: [sid, JSON.stringify(sess), this.expiresAt(sess)] }
      )
      .then(() => cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb = () => {}) {
    sequelize
      .query("UPDATE sessions SET expires = ? WHERE sid = ?", { replacements: [this.expiresAt(sess), sid] })
      .then(() => cb(null))
      .catch(cb);
  }

  destroy(sid, cb = () => {}) {
    sequelize.query("DELETE FROM sessions WHERE sid = ?", { replacements: [sid] }).then(() => cb(null)).catch(cb);
  }

  cleanup() {
    return sequelize.query("DELETE FROM sessions WHERE expires <= ?", { replacements: [Date.now()] });
  }

  close() {
    clearInterval(this.timer);
  }
}
