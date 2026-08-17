// The public surface. What src/index.ts exports is the API; this test pins
// the list so a rename or a dropped export is a deliberate diff here, not a
// surprise in a consumer's build. It also holds src/types.ts to its own
// contract: types only, no runtime code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as api from '../src/index.ts';

const EXPECTED = [
  'BUILTIN_ROLES',
  'DEFAULT_INVITATION_TTL_MS',
  'RESERVED_SLUGS',
  'TENANT_SETTING',
  'TenancyError',
  'TenantScope',
  'acceptInvitation',
  'addMember',
  'archiveTenant',
  'assertRoleAssignable',
  'atLeast',
  'authorize',
  'can',
  'coverage',
  'createTenancy',
  'createTenant',
  'createTenantWithOwner',
  'defineRole',
  'deleteRole',
  'firstOf',
  'fromClaim',
  'fromHeader',
  'fromPath',
  'fromSubdomain',
  'getInvitation',
  'getMembership',
  'getRole',
  'getTenant',
  'getTenantBySlug',
  'hasPermission',
  'hashInvitationToken',
  'invite',
  'isBuiltinRole',
  'isRole',
  'isRoleName',
  'listInvitations',
  'listMembers',
  'listRoles',
  'listTenants',
  'memoryInvitationMailer',
  'permissionsOf',
  'removeMember',
  'renameTenant',
  'requirePermission',
  'requireRole',
  'resendInvitation',
  'resolve',
  'restoreTenant',
  'revokeInvitation',
  'routedExecutor',
  'scopedExecutor',
  'setRole',
  'sweepExpiredInvitations',
  'tenantsOf',
  'updateRole',
  'validateRoleName',
  'validateSlug',
];

describe('public surface', () => {
  it('exports exactly the documented API', () => {
    assert.deepEqual(Object.keys(api).sort(), EXPECTED);
  });

  it('src/types.ts has no runtime exports', async () => {
    const types = await import('../src/types.ts');
    assert.deepEqual(Object.keys(types), []);
  });

  it('the pg adapter is not reachable from the root entry', () => {
    assert.ok(!('pgExecutor' in api), 'pg stays behind the ./pg subpath');
  });
});
