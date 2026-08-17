// Invitations: the workflow that turns "someone should join this tenant"
// into a membership row, without the host app rebuilding token tables.
//
// The token is the whole security model, so its handling is the whole file:
// 32 random bytes, base64url, returned exactly once from `invite` (and
// `resend`), stored only as a sha256. Acceptance looks the hash up, so a
// tampered token, a guessed token and a never-issued token all fail the same
// way (`unknown_invitation`) — nothing distinguishes "close" from "wrong".
//
// tenant-kit has no users table, so it cannot check that the accepting user
// *is* the invited email. Possession of the token is the proof, and the
// docstrings say so rather than implying a check that is not there. What the
// library does hold: one pending invitation per (tenant, email), a first
// acceptance that binds the invitation to that user, and refusal of every
// later acceptance by anyone else (`invitation_taken`) — the same user
// re-presenting the token is idempotent, since a retry is not a second join.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TenancyError } from './errors.ts';
import { addMember, assertRoleAssignable, isRoleName } from './members.ts';
import { getTenant } from './tenants.ts';
import type {
  Invitation,
  InvitationMailer,
  InvitationMessage,
  InvitationState,
  InviteInput,
  Membership,
  Role,
  SqlExecutor,
  TenantId,
  UserId,
} from './types.ts';

/** Seven days, unless the caller says otherwise. */
export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- tokens -----------------------------------------------------------------

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex of the clear-text token — the only form that touches the database. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// --- rows -------------------------------------------------------------------

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  invited_by: string;
  state: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, tenant_id, email, role, invited_by, state, created_at, expires_at,
  accepted_at, accepted_by, revoked_at`;
const SELECT = `SELECT ${COLUMNS} FROM tenancy.invitations`;

/**
 * Row → Invitation. A `pending` row past its `expires_at` reads as `expired`
 * whether or not the sweep has run yet: the sweep is housekeeping, not the
 * source of truth about time.
 */
export function toInvitation(row: InvitationRow, now: Date): Invitation {
  const state: InvitationState =
    row.state === 'pending' && row.expires_at.getTime() <= now.getTime()
      ? 'expired'
      : (row.state as InvitationState);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role as Role,
    invitedBy: row.invited_by,
    state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at,
  };
}

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@'))
    throw new TenancyError({ code: 'invalid_tenant', field: 'email', reason: 'not an address' });
  return trimmed;
}

// --- options ----------------------------------------------------------------

export interface InvitationOptions {
  /** Where issued tokens go. Without one, `invite`/`resend` still return the token. */
  mailer?: InvitationMailer;
  /** Default TTL when `InviteInput.ttlMs` is absent. */
  ttlMs?: number;
}

// --- operations -------------------------------------------------------------

/**
 * Issue an invitation. Returns the invitation and the clear-text token —
 * the one and only time the token is available.
 *
 * At most one invitation per (tenant, email) is pending at a time. A fresh
 * `invite` for an address that already has one *supersedes* it: the old row
 * is revoked and its token stops working. That is the behaviour a
 * re-invite from the UI means ("send them a new one"), and it keeps
 * `resend` for the case where the same invitation should go out again.
 * The revoke-then-insert runs under a transaction-scoped advisory lock keyed
 * on (tenant, email), so two concurrent invites serialize instead of both
 * inserting; the partial unique index in 003 is the backstop.
 *
 * The mailer runs after the transaction commits. If it throws, the error
 * propagates but the invitation exists — `resend` it.
 */
export async function invite(
  db: SqlExecutor,
  input: InviteInput,
  now: Date,
  options: InvitationOptions = {},
): Promise<{ invitation: Invitation; token: string }> {
  if (!isRoleName(input.role)) throw new TenancyError({ code: 'invalid_role', role: input.role });
  if (input.invitedBy.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'invitedBy', reason: 'empty' });
  const email = normalizeEmail(input.email);
  const ttl = input.ttlMs ?? options.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'ttlMs', reason: 'must be > 0' });

  const tenant = await getTenant(db, input.tenantId);
  if (tenant.state !== 'active')
    throw new TenancyError({ code: 'tenant_archived', tenantId: tenant.id });

  const token = newToken();
  const invitation = await db.transaction(async (tx) => {
    await lockInviteKey(tx, tenant.id, email);
    await assertRoleAssignable(tx, tenant.id, input.role);
    await tx.query(
      `UPDATE tenancy.invitations SET state = 'revoked', revoked_at = $3
        WHERE tenant_id = $1 AND email = $2 AND state = 'pending'`,
      [tenant.id, email, now],
    );
    const rows = await tx.query<InvitationRow>(
      `INSERT INTO tenancy.invitations
         (id, tenant_id, email, role, token_hash, invited_by, state, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        tenant.id,
        email,
        input.role,
        hashInvitationToken(token),
        input.invitedBy,
        now,
        new Date(now.getTime() + ttl),
      ],
    );
    return toInvitation(rows[0], now);
  });

  await options.mailer?.({ kind: 'invite', tenant, invitation, token });
  return { invitation, token };
}

/**
 * Serialize writers on one (tenant, email). `hashtext` of the composite key
 * is a 32-bit hash; a collision between two unrelated keys costs a moment of
 * needless waiting, never a wrong result.
 */
function lockInviteKey(tx: SqlExecutor, tenantId: TenantId, email: string): Promise<unknown> {
  return tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `tenancy.invitation:${tenantId}:${email}`,
  ]);
}

/**
 * Accept: the token becomes a membership.
 *
 * Idempotent for the accepting user — presenting the token again returns the
 * membership it created. Anyone else presenting it after that gets
 * `invitation_taken`. Expired (by time or by sweep) is `invitation_expired`;
 * revoked or superseded is `invitation_revoked`; anything else —
 * malformed, tampered, never issued — is `unknown_invitation`, because the
 * hash lookup cannot tell those apart and should not try.
 *
 * The invitation row and the membership row change in one transaction under
 * a row lock on the invitation, so two users racing the same token resolve
 * to one member and one `invitation_taken`. If the user is already a member
 * in a different role, `addMember`'s `already_a_member` propagates: an
 * invitation is not a role change in disguise.
 */
export async function acceptInvitation(
  db: SqlExecutor,
  input: { token: string; userId: UserId },
  now: Date,
): Promise<{ invitation: Invitation; membership: Membership }> {
  if (input.userId.trim().length === 0)
    throw new TenancyError({ code: 'invalid_tenant', field: 'userId', reason: 'empty' });
  const hash = hashInvitationToken(input.token);
  return db.transaction(async (tx) => {
    const rows = await tx.query<InvitationRow>(`${SELECT} WHERE token_hash = $1 FOR UPDATE`, [
      hash,
    ]);
    if (rows.length === 0) throw new TenancyError({ code: 'unknown_invitation', ref: 'token' });
    const found = toInvitation(rows[0], now);
    refuseUnlessAcceptable(found, input.userId);

    if (found.state === 'accepted') {
      // Same user, second presentation: hand back what the first one made.
      const membership = await addMember(
        tx,
        { tenantId: found.tenantId, userId: input.userId, role: found.role },
        now,
      );
      return { invitation: found, membership };
    }

    const tenant = await getTenant(tx, found.tenantId);
    if (tenant.state !== 'active')
      throw new TenancyError({ code: 'tenant_archived', tenantId: tenant.id });

    const membership = await addMember(
      tx,
      { tenantId: found.tenantId, userId: input.userId, role: found.role },
      now,
    );
    const updated = await tx.query<InvitationRow>(
      `UPDATE tenancy.invitations
          SET state = 'accepted', accepted_at = $2, accepted_by = $3
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [found.id, now, input.userId],
    );
    return { invitation: toInvitation(updated[0], now), membership };
  });
}

function refuseUnlessAcceptable(invitation: Invitation, userId: UserId): void {
  switch (invitation.state) {
    case 'pending':
      return;
    case 'expired':
      throw new TenancyError({
        code: 'invitation_expired',
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
      });
    case 'revoked':
      throw new TenancyError({ code: 'invitation_revoked', invitationId: invitation.id });
    case 'accepted':
      if (invitation.acceptedBy === userId) return;
      throw new TenancyError({
        code: 'invitation_taken',
        invitationId: invitation.id,
        acceptedBy: invitation.acceptedBy as UserId,
      });
  }
}

export async function getInvitation(db: SqlExecutor, id: string, now: Date): Promise<Invitation> {
  const rows = await db.query<InvitationRow>(`${SELECT} WHERE id = $1`, [id]);
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_invitation', ref: id });
  return toInvitation(rows[0], now);
}

/**
 * Every invitation the tenant has issued, newest last; `state` filters on the
 * *effective* state, so `pending` excludes rows that have timed out even
 * before the sweep has marked them.
 */
export async function listInvitations(
  db: SqlExecutor,
  tenantId: TenantId,
  now: Date,
  query: { state?: InvitationState } = {},
): Promise<Invitation[]> {
  const rows = await db.query<InvitationRow>(
    `${SELECT} WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId],
  );
  const all = rows.map((row) => toInvitation(row, now));
  return query.state === undefined ? all : all.filter((i) => i.state === query.state);
}

/**
 * Revoke, idempotently: revoking a revoked invitation returns it unchanged
 * (first revocation is the fact). An accepted invitation cannot be revoked —
 * the membership it produced is what to remove — so that is
 * `invitation_taken`. Revoking an expired one is allowed and does what it
 * says: the row stops being pending for good, sweep or no sweep.
 */
export async function revokeInvitation(
  db: SqlExecutor,
  id: string,
  now: Date,
): Promise<Invitation> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<InvitationRow>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id]);
    if (rows.length === 0) throw new TenancyError({ code: 'unknown_invitation', ref: id });
    const found = toInvitation(rows[0], now);
    if (found.state === 'revoked') return found;
    if (found.state === 'accepted')
      throw new TenancyError({
        code: 'invitation_taken',
        invitationId: found.id,
        acceptedBy: found.acceptedBy as UserId,
      });
    const updated = await tx.query<InvitationRow>(
      `UPDATE tenancy.invitations SET state = 'revoked', revoked_at = $2
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, now],
    );
    return toInvitation(updated[0], now);
  });
}

/**
 * Send the same invitation again with a fresh token and a fresh expiry. The
 * previous token stops working — one live token per invitation. Works for a
 * pending invitation and for one that has expired (that is what a resend is
 * *for*); refuses revoked (`invitation_revoked`) and accepted
 * (`invitation_taken`) ones, because reviving either would undo a decision.
 */
export async function resendInvitation(
  db: SqlExecutor,
  id: string,
  now: Date,
  options: InvitationOptions = {},
): Promise<{ invitation: Invitation; token: string }> {
  const ttl = options.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
  const token = newToken();
  const invitation = await db.transaction(async (tx) => {
    const rows = await tx.query<InvitationRow>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id]);
    if (rows.length === 0) throw new TenancyError({ code: 'unknown_invitation', ref: id });
    const found = toInvitation(rows[0], now);
    if (found.state === 'revoked')
      throw new TenancyError({ code: 'invitation_revoked', invitationId: found.id });
    if (found.state === 'accepted')
      throw new TenancyError({
        code: 'invitation_taken',
        invitationId: found.id,
        acceptedBy: found.acceptedBy as UserId,
      });
    const updated = await tx.query<InvitationRow>(
      `UPDATE tenancy.invitations
          SET state = 'pending', token_hash = $2, expires_at = $3
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, hashInvitationToken(token), new Date(now.getTime() + ttl)],
    );
    return toInvitation(updated[0], now);
  });
  const tenant = await getTenant(db, invitation.tenantId);
  await options.mailer?.({ kind: 'resend', tenant, invitation, token });
  return { invitation, token };
}

/**
 * Mark timed-out pending invitations `expired`. Housekeeping: `accept` and
 * `list` already treat a pending row past its expiry as expired, so nothing
 * depends on this running — but a table of stale `pending` rows misleads
 * whoever reads it directly, and a dashboard counting `state = 'pending'`
 * in SQL should agree with `list`. Returns how many rows changed.
 */
export async function sweepExpiredInvitations(db: SqlExecutor, now: Date): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE tenancy.invitations SET state = 'expired'
      WHERE state = 'pending' AND expires_at <= $1
      RETURNING id`,
    [now],
  );
  return rows.length;
}

// --- test seam --------------------------------------------------------------

/**
 * A mailer that keeps what it was given. For tests and for wiring checks;
 * the `sent` array is the assertion surface.
 */
export function memoryInvitationMailer(): { mailer: InvitationMailer; sent: InvitationMessage[] } {
  const sent: InvitationMessage[] = [];
  return {
    sent,
    mailer: async (message) => {
      sent.push(message);
    },
  };
}
