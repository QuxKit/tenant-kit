// Public surface. One entry point; what is exported here is the API, and what
// is not, is not.

export { TenantScope } from './context.ts';

export { TenancyError, type TenancyErrorCode, type TenancyFailure } from './errors.ts';
export { createTenancy, type Tenancy, type TenancyOptions } from './instance.ts';
export { routedExecutor, scopedExecutor, TENANT_SETTING } from './isolation.ts';
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
export {
  authorize,
  firstOf,
  fromClaim,
  fromHeader,
  fromPath,
  fromSubdomain,
  resolve,
} from './resolve.ts';
export {
  archiveTenant,
  createTenant,
  getTenant,
  getTenantBySlug,
  listTenants,
  RESERVED_SLUGS,
  renameTenant,
  restoreTenant,
  validateSlug,
} from './tenants.ts';
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
