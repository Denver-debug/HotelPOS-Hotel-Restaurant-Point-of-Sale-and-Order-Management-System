// Domain events via a transactional outbox (Figure 15: "publish OrderCompleted").
// Events are written in the same DB transaction as the business change, then
// dispatched to the ERP event bus by publishPending(). No event bus is configured
// yet, so the default publisher only logs (MOCK) and marks events as published.
import { IntegrationEvent } from "../../models/index.js";
import { logged } from "../integrationLogger.js";

export async function recordEvent(eventType, aggregateType, aggregateId, payload, transaction) {
  return IntegrationEvent.create({ eventType, aggregateType, aggregateId: String(aggregateId), payload }, { transaction });
}

// Replace with an SQS / message-broker publisher when the Integration Layer is available.
export const logOnlyPublisher = {
  name: "LogOnlyPublisher",
  isMock: true,
  async publish(event) {
    return { delivered: true, messageId: `MOCK-EVT-${event.id}` };
  },
};

export async function publishPending({ publisher = logOnlyPublisher, limit = 50, userId } = {}) {
  const events = await IntegrationEvent.findAll({ where: { status: ["PENDING", "FAILED"] }, order: [["id", "ASC"]], limit });
  let published = 0;
  for (const event of events) {
    try {
      await logged(
        { system: "EVENT", operation: event.eventType, isMock: publisher.isMock, referenceType: event.aggregateType, referenceId: event.aggregateId, request: event.payload, userId },
        () => publisher.publish(event)
      );
      await event.update({ status: "PUBLISHED", publishedAt: new Date(), attempts: event.attempts + 1, lastError: null });
      published++;
    } catch (err) {
      await event.update({ status: "FAILED", attempts: event.attempts + 1, lastError: String(err.message).slice(0, 500) });
    }
  }
  return { attempted: events.length, published };
}
