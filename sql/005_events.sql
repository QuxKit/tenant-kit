-- Lifecycle events (an outbox) and the audit log.
--
-- Both are written *inside* the transaction that performs the mutation they
-- describe, by the library, so an event cannot fire for a change that rolled
-- back and a change cannot commit without its event. That is the whole
-- reason they live here rather than in a queue publish the host app wraps
-- around each call.
--
-- `events` is an outbox: a worker polls unacked rows in id order and acks
-- what it has handled. `id` is a bigserial, assigned at insert time, not at
-- commit — so two concurrent transactions may commit in the opposite order
-- to their ids. Poll unacked rows and ack them; do not treat "highest id I
-- have seen" as a durable cursor.
--
-- `audit_log` is append-only by convention and written only when the
-- mutating call knows *who* acted. No FK to tenants: an audit row must
-- outlive whatever it describes.

CREATE TABLE IF NOT EXISTS tenancy.events (
  id         bigserial   PRIMARY KEY,
  tenant_id  text        NOT NULL,
  type       text        NOT NULL CHECK (btrim(type) <> ''),
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actor      text,
  at         timestamptz NOT NULL,
  acked_at   timestamptz
);

-- The poll: unacked rows in id order.
CREATE INDEX IF NOT EXISTS events_unacked ON tenancy.events (id) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS events_by_tenant ON tenancy.events (tenant_id, id);

CREATE TABLE IF NOT EXISTS tenancy.audit_log (
  id         bigserial   PRIMARY KEY,
  tenant_id  text        NOT NULL,
  actor      text        NOT NULL CHECK (btrim(actor) <> ''),
  action     text        NOT NULL CHECK (btrim(action) <> ''),
  target     text        NOT NULL,
  at         timestamptz NOT NULL,
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_by_tenant ON tenancy.audit_log (tenant_id, id);
