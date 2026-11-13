// Domain events via a transactional outbox (Figure 15: "publish OrderCompleted").
//
// 1. recordEvent() inserts the event in the SAME transaction as the business change, so an
//    event exists if and only if the change committed.
// 2. publishPending() (run by the dispatcher every EVENTS_DISPATCH_INTERVAL_MS, or by
//    "Dispatch now") claims due events and hands each to the configured publisher:
//      log      — records the event as delivered (no ERP endpoint yet)
//      webhook  — POSTs the envelope to EVENTS_WEBHOOK_URL, HMAC-SHA256 signed
//    Delivery is at-least-once: consumers de-duplicate on the event id.
// 3. Other systems can also PULL events (GET /api/v1/events?after=<sequence>), independent of push.
//
// Envelope (docs/API.md "Events"):
//   { id, sequence, type, schemaVersion, occurredAt, source: "hotelpos", outletId,
//     aggregate: { type, id }, data }
import crypto from "crypto";
import { createRequire } from "module";
import { Op, QueryTypes } from "sequelize";
import { sequelize, IntegrationEvent } from "../../models/index.js";
import { logged, IntegrationError } from "../integrationLogger.js";
import { requestJson } from "../httpClient.js";
import { config } from "../../config/env.js";

const pkg = createRequire(import.meta.url)("../../package.json");
const CLAIM_LEASE_MS = 2 * 60 * 1000; // a crashed dispatcher's claim expires and is retried
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export async function recordEvent(eventType, aggregateType, aggregateId, payload, transaction, { outletId = null, schemaVersion = 1 } = {}) {
  return IntegrationEvent.create(
    { eventUid: crypto.randomUUID(), eventType, schemaVersion, aggregateType, aggregateId: String(aggregateId), outletId: outletId ?? payload?.outletId ?? null, payload },
    { transaction }
  );
}

export function envelope(event) {
  const e = event.get ? event.get({ plain: true }) : event;
  return {
    id: e.eventUid,
    sequence: Number(e.id),
    type: e.eventType,
    schemaVersion: e.schemaVersion ?? 1,
    occurredAt: new Date(e.createdAt).toISOString(),
    source: "hotelpos",
    outletId: e.outletId ?? null,
    aggregate: { type: e.aggregateType, id: e.aggregateId },
    data: e.payload,
  };
}

// ── Publishers ───────────────────────────────────────────────────────────

export const logOnlyPublisher = {
  name: "LogOnlyPublisher",
  isMock: true,
  async publish(env) {
    return { delivered: true, messageId: `LOG-${env.id}` };
  },
};

// Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex, sent as "sha256=<hex>".
export const signWebhook = (secret, timestamp, body) => crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export function webhookPublisher({ url, secret, timeoutMs = 10000 }) {
  return {
    name: "WebhookPublisher",
    isMock: false,
    endpoint: url,
    async publish(env) {
      const body = JSON.stringify(env);
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await requestJson({
        baseUrl: url,
        path: "",
        method: "POST",
        timeoutMs,
        rawBody: body,
        idempotencyKey: env.id,
        expectJson: false,
        headers: {
          "User-Agent": `HotelPOS/${pkg.version}`,
          "X-HotelPOS-Event": env.type,
          "X-HotelPOS-Delivery": env.id,
          "X-HotelPOS-Timestamp": String(timestamp),
          "X-HotelPOS-Signature": `sha256=${signWebhook(secret, timestamp, body)}`,
        },
      });
      if (!res.ok) throw new IntegrationError("REJECTED", `Webhook returned HTTP ${res.httpStatus}.`, { httpStatus: res.httpStatus, response: res.data });
      return { delivered: true, httpStatus: res.httpStatus };
    },
  };
}

let configured;
export function getEventPublisher() {
  if (!configured) {
    const { publisher, webhookUrl, webhookSecret, timeoutMs } = config.events;
    configured = publisher === "webhook" ? webhookPublisher({ url: webhookUrl, secret: webhookSecret, timeoutMs }) : logOnlyPublisher;
  }
  return configured;
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export const backoffMs = (attempts) => Math.min(MAX_BACKOFF_MS, 30000 * 2 ** Math.max(0, attempts - 1));

// Claims due events with FOR UPDATE SKIP LOCKED (two dispatchers never take the same row) and
// leases them by pushing next_attempt_at forward. An event waits while an earlier event of the
// same aggregate is undelivered, so e.g. OrderRefunded never arrives before OrderCompleted.
async function claim(limit) {
  return sequelize.transaction(async (transaction) => {
    const rows = await sequelize.query(
      `SELECT e.id FROM integration_events e
        WHERE e.status IN ('PENDING','FAILED')
          AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= NOW(3))
          AND NOT EXISTS (SELECT 1 FROM integration_events p
                           WHERE p.aggregate_type = e.aggregate_type AND p.aggregate_id = e.aggregate_id
                             AND p.id < e.id AND p.status <> 'PUBLISHED')
        ORDER BY e.id
        LIMIT :limit
        FOR UPDATE OF e SKIP LOCKED`,
      { replacements: { limit }, type: QueryTypes.SELECT, transaction }
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) await IntegrationEvent.update({ nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) }, { where: { id: ids }, transaction });
    return ids;
  });
}

// Each claim takes at most the oldest undelivered event per aggregate, so a run claims in rounds:
// an order's PaymentCaptured and OrderCompleted go out in the same run, one after the other.
const MAX_ROUNDS = 10;

export async function publishPending({ publisher = getEventPublisher(), limit = config.events.batchSize, maxAttempts = config.events.maxAttempts, userId } = {}) {
  const totals = { attempted: 0, published: 0, failed: 0, dead: 0, publisher: publisher.name };
  for (let round = 0; round < MAX_ROUNDS && totals.attempted < limit; round++) {
    const ids = await claim(limit - totals.attempted);
    if (!ids.length) break;
    const events = await IntegrationEvent.findAll({ where: { id: ids }, order: [["id", "ASC"]] });
    const r = await deliver(events, { publisher, maxAttempts, userId });
    totals.attempted += events.length;
    totals.published += r.published;
    totals.failed += r.failed;
    totals.dead += r.dead;
  }
  return totals;
}

async function deliver(events, { publisher, maxAttempts, userId }) {
  let published = 0;
  let failed = 0;
  let dead = 0;
  const blocked = new Set(); // aggregates whose earlier event just failed in this batch
  for (const event of events) {
    const aggregate = `${event.aggregateType}:${event.aggregateId}`;
    if (blocked.has(aggregate)) {
      await event.update({ nextAttemptAt: null });
      continue;
    }
    const attempts = event.attempts + 1;
    try {
      await logged(
        { system: "EVENT", operation: event.eventType, isMock: publisher.isMock, idempotencyKey: event.eventUid, referenceType: event.aggregateType, referenceId: event.aggregateId, request: envelope(event), userId },
        () => publisher.publish(envelope(event))
      );
      await event.update({ status: "PUBLISHED", publishedAt: new Date(), attempts, nextAttemptAt: null, lastError: null });
      published++;
    } catch (err) {
      blocked.add(aggregate);
      const giveUp = attempts >= maxAttempts;
      await event.update({
        status: giveUp ? "DEAD" : "FAILED",
        attempts,
        nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(attempts)),
        lastError: String(err.message).slice(0, 500),
      });
      if (giveUp) dead++;
      else failed++;
    }
  }
  return { attempted: events.length, published, failed, dead, publisher: publisher.name };
}

// Operator action: give DEAD (or FAILED) events a fresh set of attempts, due now.
export async function retryEvents({ statuses = ["DEAD"] } = {}) {
  const [count] = await IntegrationEvent.update({ status: "FAILED", attempts: 0, nextAttemptAt: null }, { where: { status: { [Op.in]: statuses } } });
  return count;
}

// ── Pull feed ────────────────────────────────────────────────────────────

// Events become visible after a short settle time, so a consumer reading by sequence never
// skips an event whose transaction committed a moment after a later one.
const FEED_SETTLE_MS = 3000;

export async function eventFeed({ after = 0, limit = 100, types = null, outletIds = null }) {
  const where = { id: { [Op.gt]: after }, createdAt: { [Op.lte]: new Date(Date.now() - FEED_SETTLE_MS) } };
  if (types?.length) where.eventType = { [Op.in]: types };
  if (outletIds) where[Op.or] = [{ outletId: null }, { outletId: { [Op.in]: outletIds.length ? outletIds : [-1] } }];
  const rows = await IntegrationEvent.findAll({ where, order: [["id", "ASC"]], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    events: page.map(envelope),
    nextAfter: page.length ? Number(page[page.length - 1].id) : Number(after),
    hasMore: rows.length > limit,
  };
}
