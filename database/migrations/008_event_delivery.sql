-- Event delivery to the ERP (transactional outbox, webhook push and pull feed).
--  event_uid       stable id consumers de-duplicate on (also sent as the webhook delivery id)
--  schema_version  version of the event's data shape
--  outlet_id       lets the pull feed honour the caller's outlet assignment
--  next_attempt_at retry schedule (exponential backoff); also the claim lease of a dispatcher
--  DEAD            gave up after EVENTS_MAX_ATTEMPTS; an operator can retry it
ALTER TABLE integration_events
  ADD COLUMN event_uid CHAR(36) NULL AFTER id,
  ADD COLUMN schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER event_type,
  ADD COLUMN outlet_id INT UNSIGNED NULL AFTER aggregate_id,
  ADD COLUMN next_attempt_at DATETIME(3) NULL AFTER attempts,
  MODIFY COLUMN status ENUM('PENDING','PUBLISHED','FAILED','DEAD') NOT NULL DEFAULT 'PENDING';

UPDATE integration_events SET event_uid = UUID() WHERE event_uid IS NULL;

ALTER TABLE integration_events
  MODIFY COLUMN event_uid CHAR(36) NOT NULL,
  ADD UNIQUE KEY uq_integration_events_uid (event_uid),
  ADD KEY idx_integration_events_due (status, next_attempt_at, id),
  ADD KEY idx_integration_events_outlet (outlet_id, id),
  ADD KEY idx_integration_events_type (event_type, id);
