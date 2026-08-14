// Public surface. One entry point; what is exported here is the API, and what
// is not, is not.

export type {
  AddMemberInput,
  Clock,
  CreateTenantInput,
  Extractor,
  Logger,
  Membership,
  RequestLike,
  ResolvedTenant,
  Role,
  SqlExecutor,
  Tenant,
  TenantClaim,
  TenantContext,
  TenantId,
  TenantState,
  UserId,
} from './types.ts';

export { TenancyError, type TenancyErrorCode, type TenancyFailure } from './errors.ts';

export {
  archiveTenant,
  createTenant,
  getTenant,
  getTenantBySlug,
  listTenants,
  renameTenant,
  restoreTenant,
  validateSlug,
  RESERVED_SLUGS,
} from './tenants.ts';

export {
  addMember,
  atLeast,
  getMembership,
  isRole,
  listMembers,
  removeMember,
  requireRole,
  setRole,
  tenantsOf,
} from './members.ts';

export { authorize, firstOf, fromClaim, fromHeader, fromPath, fromSubdomain, resolve } from './resolve.ts';

export { TenantScope } from './context.ts';

export { routedExecutor, scopedExecutor, TENANT_SETTING } from './isolation.ts';

export { createTenancy, type Tenancy, type TenancyOptions } from './instance.ts';
