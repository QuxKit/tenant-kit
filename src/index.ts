// Public surface. One entry point; what is exported here is the API, and what
// is not, is not.

export { TenantScope } from './context.ts';

export { TenancyError, type TenancyErrorCode, type TenancyFailure } from './errors.ts';
export {
  createTenancy,
  type Tenancy,
  type TenancyInvitations,
  type TenancyOptions,
  type TenancyRoles,
} from './instance.ts';
export {
  acceptInvitation,
  DEFAULT_INVITATION_TTL_MS,
  getInvitation,
  hashInvitationToken,
  invite,
  listInvitations,
  memoryInvitationMailer,
  resendInvitation,
  revokeInvitation,
  sweepExpiredInvitations,
} from './invitations.ts';
export {
  type RoutedExecutor,
  type RoutedExecutorOptions,
  routedExecutor,
  scopedExecutor,
  TENANT_SETTING,
} from './isolation.ts';
export {
  addMember,
  assertRoleAssignable,
  atLeast,
  getMembership,
  isBuiltinRole,
  isRole,
  isRoleName,
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
  BUILTIN_ROLES,
  can,
  defineRole,
  deleteRole,
  getRole,
  hasPermission,
  listRoles,
  permissionsOf,
  requirePermission,
  updateRole,
  validateRoleName,
} from './roles.ts';
export {
  archiveTenant,
  createTenant,
  createTenantWithOwner,
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
  BuiltinRole,
  Clock,
  CreateTenantInput,
  DefineRoleInput,
  Extractor,
  Invitation,
  InvitationMailer,
  InvitationMessage,
  InvitationState,
  InviteInput,
  Logger,
  Membership,
  RequestLike,
  ResolvedTenant,
  Role,
  RoleDefinition,
  SqlExecutor,
  Tenant,
  TenantClaim,
  TenantContext,
  TenantId,
  TenantState,
  UserId,
} from './types.ts';
