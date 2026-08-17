// Typed failures.
//
// Same contract as billing-kit's errors module, for the same reason: a caller
// deciding what to do — return 404, return 403, redirect to a tenant picker,
// retry — has to distinguish "no such tenant" from "not your tenant" from "no
// claim in the request at all", and if the only difference is prose then the
// decision is a substring match that breaks the first time the wording
// improves. The union is the contract; the message is derived from it, never
// parsed.
//
// One distinction in this file is security-relevant and worth naming:
// `unknown_tenant` and `not_a_member` are different codes internally, but a
// public endpoint should usually answer both with the same 404. Whether the
// tenant exists is itself information — an attacker enumerating slugs learns
// from a 403 that the slug is real. The union keeps the distinction so *you*
// can log it; what you reveal over HTTP is your choice, made once in your
// error mapper instead of implicitly everywhere.

import type { BuiltinRole, Role, TenantId, UserId } from './types.ts';

export type TenancyFailure =
  // --- tenants -------------------------------------------------------------
  | { code: 'invalid_slug'; slug: string; reason: string }
  | { code: 'invalid_tenant'; field: string; reason: string }
  /** The slug exists with a different name or state. Creating with identical
   *  input is idempotent and does not raise this; `detail` names what
   *  differed, so the caller does not have to query to find out. */
  | { code: 'slug_taken'; slug: string; detail?: string }
  | { code: 'unknown_tenant'; ref: string }
  | { code: 'tenant_archived'; tenantId: TenantId }
  /** The merged settings document would exceed the cap. Nothing was written. */
  | { code: 'settings_too_large'; tenantId: TenantId; bytes: number; maxBytes: number }
  /** `eraseTenant` on an active tenant. Archive first; erasure is two steps on purpose. */
  | { code: 'tenant_not_archived'; tenantId: TenantId }

  // --- membership ----------------------------------------------------------
  /** Not a role name this tenant knows: not built-in and not defined here,
   *  or (on `defineRole`) a name that is malformed or reserved. */
  | { code: 'invalid_role'; role: string; reason?: string }
  | { code: 'unknown_role'; tenantId: TenantId; role: string }
  /** `deleteRole` on a role that memberships or pending invitations still
   *  name. Reassign them first; a membership with a dangling role is a
   *  member with no permissions and no explanation. */
  | { code: 'role_in_use'; tenantId: TenantId; role: string; members: number; invitations: number }
  | { code: 'permission_denied'; tenantId: TenantId; userId: UserId; permission: string }
  | { code: 'not_a_member'; tenantId: TenantId; userId: UserId }
  /** The membership exists with a different role. Adding with the same role
   *  is idempotent and does not raise this. */
  | { code: 'already_a_member'; tenantId: TenantId; userId: UserId; role: Role }
  /** Removing or demoting the only owner. Held as an invariant in the store —
   *  under a row lock, not a read-then-write — because a tenant with no owner
   *  is a tenant nobody can administer, ever again. */
  | { code: 'last_owner'; tenantId: TenantId; userId: UserId }
  | { code: 'forbidden'; tenantId: TenantId; userId: UserId; need: BuiltinRole; have: Role }

  // --- invitations ---------------------------------------------------------
  /** No invitation for the token or id. Tokens are looked up by hash, so a
   *  tampered token and a never-issued one are the same failure. */
  | { code: 'unknown_invitation'; ref: string }
  | { code: 'invitation_expired'; invitationId: string; expiresAt: Date }
  | { code: 'invitation_revoked'; invitationId: string }
  /** Already accepted by a different user. The same user accepting again is
   *  idempotent and does not raise this. */
  | { code: 'invitation_taken'; invitationId: string; acceptedBy: UserId }

  // --- resolution ----------------------------------------------------------
  /** No strategy found anything in the request to even claim a tenant. */
  | { code: 'no_tenant_claim' }

  // --- context -------------------------------------------------------------
  | { code: 'no_tenant_context' };

export type TenancyErrorCode = TenancyFailure['code'];

function describe(failure: TenancyFailure): string {
  switch (failure.code) {
    case 'invalid_slug':
      return `invalid slug ${JSON.stringify(failure.slug)}: ${failure.reason}`;
    case 'invalid_tenant':
      return `tenant field ${failure.field} is invalid: ${failure.reason}`;
    case 'slug_taken':
      return (
        `slug ${failure.slug} is already taken` +
        (failure.detail === undefined ? '' : ` (${failure.detail})`)
      );
    case 'unknown_tenant':
      return `no tenant for ${failure.ref}`;
    case 'tenant_archived':
      return `tenant ${failure.tenantId} is archived`;
    case 'settings_too_large':
      return `settings for tenant ${failure.tenantId} would be ${failure.bytes} bytes; the cap is ${failure.maxBytes}`;
    case 'tenant_not_archived':
      return `tenant ${failure.tenantId} is not archived; archive it before erasing`;
    case 'invalid_role':
      return (
        `not a role: ${JSON.stringify(failure.role)}` +
        (failure.reason === undefined ? '' : ` (${failure.reason})`)
      );
    case 'unknown_role':
      return `tenant ${failure.tenantId} has no role ${JSON.stringify(failure.role)}`;
    case 'role_in_use':
      return `role ${failure.role} of tenant ${failure.tenantId} is held by ${failure.members} member(s) and ${failure.invitations} pending invitation(s)`;
    case 'permission_denied':
      return `user ${failure.userId} lacks ${failure.permission} in tenant ${failure.tenantId}`;
    case 'not_a_member':
      return `user ${failure.userId} is not a member of tenant ${failure.tenantId}`;
    case 'already_a_member':
      return `user ${failure.userId} is already a member of tenant ${failure.tenantId} as ${failure.role}`;
    case 'last_owner':
      return `user ${failure.userId} is the last owner of tenant ${failure.tenantId}`;
    case 'forbidden':
      return `user ${failure.userId} is ${failure.have} in tenant ${failure.tenantId}; ${failure.need} required`;
    case 'unknown_invitation':
      return `no invitation for ${failure.ref}`;
    case 'invitation_expired':
      return `invitation ${failure.invitationId} expired at ${failure.expiresAt.toISOString()}`;
    case 'invitation_revoked':
      return `invitation ${failure.invitationId} was revoked`;
    case 'invitation_taken':
      return `invitation ${failure.invitationId} was already accepted by ${failure.acceptedBy}`;
    case 'no_tenant_claim':
      return `no tenant claim found in the request`;
    case 'no_tenant_context':
      return `no tenant context; call inside run() or pass a tenantId explicitly`;
  }
}

/**
 * The one error class. Carries the union; the message is generated from it.
 *
 * `failure` is the field to switch on. A caller that reads `.message` to
 * decide anything has reintroduced the problem this type solves.
 */
export class TenancyError extends Error {
  readonly failure: TenancyFailure;
  readonly code: TenancyErrorCode;

  constructor(failure: TenancyFailure) {
    super(describe(failure));
    this.name = 'TenancyError';
    this.failure = failure;
    this.code = failure.code;
  }

  /** Narrow without instanceof, which fails across duplicated module copies. */
  static is(error: unknown): error is TenancyError {
    return error instanceof Error && error.name === 'TenancyError' && 'failure' in error;
  }

  static hasCode<C extends TenancyErrorCode>(
    error: unknown,
    code: C,
  ): error is TenancyError & { failure: Extract<TenancyFailure, { code: C }> } {
    return TenancyError.is(error) && error.code === code;
  }
}
