// Lifecycle events and the audit log — the two records every mutation
// leaves behind, written in the mutation's own transaction.
//
// Why in the transaction: the host-app version of this — publish to a queue
// after `createTenant` returns — has two failure modes that both end in a
// support ticket. The publish succeeds and the enclosing transaction rolls
// back (a phantom "tenant created"); or the transaction commits and the
// publish fails (a tenant nobody downstream heard about). An outbox row in
// the same transaction has neither: it exists exactly when the change does.
// A worker drains it with `pollEvents` / `ackEvents`.
//
// The audit log answers a different question — *who* — and so it is only
// written when the mutating call knows an actor. `MutationMeta` carries
// that (plus free-form metadata) into every mutating free function as its
// last argument; the instance fills it from `as(actor)` or from the ambient
// `ResolvedTenant`'s membership.

import type { SqlExecutor, TenantId, UserId } from './types.ts';

export type TenancyEventType =
  | 'tenant_created'
  | 'tenant_renamed'
  | 'tenant_archived'
  | 'tenant_restored'
  | 'member_added'
  | 'member_role_changed'
  | 'member_removed'
  | 'invitation_issued'
  | 'invitation_accepted'
  | 'invitation_revoked'
  | 'invitation_resent'
  | 'invitation_expired'
  | 'role_defined'
  | 'role_updated'
  | 'role_deleted';

export interface TenancyEvent {
  /** Monotonic per insert, not per commit — see the module comment. */
  id: number;
  tenantId: TenantId;
  type: TenancyEventType;
  payload: Record<string, unknown>;
  actor: UserId | null;
  at: Date;
  ackedAt: Date | null;
}

export interface AuditEntry {
  id: number;
  tenantId: TenantId;
  actor: UserId;
  action: TenancyEventType;
  /** What was acted on: a user id, an invitation id, a role name, the tenant id. */
  target: string;
  at: Date;
  metadata: Record<string, unknown>;
}

/**
 * Who is doing this, and anything else worth keeping with the audit row.
 * Every mutating free function takes one as its last argument. `actor`
 * absent means "no audit row" — the event is still written.
 */
export interface MutationMeta {
  actor?: UserId;
  metadata?: Record<string, unknown>;
}

// --- writing ----------------------------------------------------------------

export interface RecordInput {
  tenantId: TenantId;
  type: TenancyEventType;
  /** The event's payload; also the audit row's metadata unless `meta.metadata` adds to it. */
  payload: Record<string, unknown>;
  target: string;
  at: Date;
  meta?: MutationMeta;
}

/**
 * Write the event, and the audit row if there is an actor. Called by the
 * mutating functions on their own transaction executor; never on the pool.
 */
export async function record(tx: SqlExecutor, input: RecordInput): Promise<void> {
  const actor = input.meta?.actor;
  await tx.query(
    `INSERT INTO tenancy.events (tenant_id, type, payload, actor, at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [input.tenantId, input.type, JSON.stringify(input.payload), actor ?? null, input.at],
  );
  if (actor === undefined) return;
  await tx.query(
    `INSERT INTO tenancy.audit_log (tenant_id, actor, action, target, at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.tenantId,
      actor,
      input.type,
      input.target,
      input.at,
      JSON.stringify({ ...input.payload, ...(input.meta?.metadata ?? {}) }),
    ],
  );
}

// --- reading ----------------------------------------------------------------

interface EventRow {
  id: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  actor: string | null;
  at: Date;
  acked_at: Date | null;
}

function toEvent(row: EventRow): TenancyEvent {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    type: row.type as TenancyEventType,
    payload: row.payload,
    actor: row.actor,
    at: row.at,
    ackedAt: row.acked_at,
  };
}

/**
 * Unacked events in id order, at most `limit` (default 100, max 1000),
 * optionally only those with `id > after`. Ack what you handle; `after` is
 * for paging within a drain, not a durable cursor (ids are assigned before
 * commit, so a lower id can appear after a higher one was polled).
 */
export async function pollEvents(
  db: SqlExecutor,
  query: { after?: number; limit?: number } = {},
): Promise<TenancyEvent[]> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 100)), 1000);
  const rows = await db.query<EventRow>(
    `SELECT id, tenant_id, type, payload, actor, at, acked_at FROM tenancy.events
      WHERE acked_at IS NULL AND id > $1
      ORDER BY id
      LIMIT $2`,
    [query.after ?? 0, limit],
  );
  return rows.map(toEvent);
}

/** Mark events handled. Idempotent; unknown ids are ignored. Returns how many changed. */
export async function ackEvents(
  db: SqlExecutor,
  ids: readonly number[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.query<{ id: string }>(
    `UPDATE tenancy.events SET acked_at = $2
      WHERE id = ANY($1::bigint[]) AND acked_at IS NULL
      RETURNING id`,
    [ids, now],
  );
  return rows.length;
}

/** Events for one tenant, acked or not, oldest first — the tenant's timeline. */
export async function listEvents(
  db: SqlExecutor,
  tenantId: TenantId,
  query: { limit?: number; after?: number } = {},
): Promise<TenancyEvent[]> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 100)), 1000);
  const rows = await db.query<EventRow>(
    `SELECT id, tenant_id, type, payload, actor, at, acked_at FROM tenancy.events
      WHERE tenant_id = $1 AND id > $2
      ORDER BY id
      LIMIT $3`,
    [tenantId, query.after ?? 0, limit],
  );
  return rows.map(toEvent);
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  target: string;
  at: Date;
  metadata: Record<string, unknown>;
}

/** The audit trail for a tenant, newest first, paged by `before` (an id). */
export async function listAudit(
  db: SqlExecutor,
  tenantId: TenantId,
  query: { limit?: number; before?: number; actor?: UserId } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 100)), 1000);
  const rows = await db.query<AuditRow>(
    `SELECT id, tenant_id, actor, action, target, at, metadata FROM tenancy.audit_log
      WHERE tenant_id = $1
        AND ($2::bigint IS NULL OR id < $2)
        AND ($3::text IS NULL OR actor = $3)
      ORDER BY id DESC
      LIMIT $4`,
    [tenantId, query.before ?? null, query.actor ?? null, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    tenantId: row.tenant_id,
    actor: row.actor,
    action: row.action as TenancyEventType,
    target: row.target,
    at: row.at,
    metadata: row.metadata,
  }));
}
