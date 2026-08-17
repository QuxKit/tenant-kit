// Invitations, against a real Postgres. The token model is the point: hashed
// at rest, returned once, single-use per user; and every way an acceptance
// can go wrong — twice, revoked, expired, someone else — is a named error.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { TenancyError } from '../src/errors.ts';
import { createTenancy } from '../src/instance.ts';
import { hashInvitationToken, memoryInvitationMailer, toInvitation } from '../src/invitations.ts';
import { describeDb, setupDatabase } from './harness.ts';

const T0 = new Date('2026-08-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('invitation tokens', () => {
  it('hash is sha256 hex, deterministic', () => {
    assert.equal(hashInvitationToken('abc'), hashInvitationToken('abc'));
    assert.match(hashInvitationToken('abc'), /^[0-9a-f]{64}$/);
  });

  it('a pending row past its expiry reads as expired without a sweep', () => {
    const row = {
      id: 'i',
      tenant_id: 't',
      email: 'a@b.c',
      role: 'member',
      invited_by: 'u',
      state: 'pending',
      created_at: T0,
      expires_at: new Date(T0.getTime() + DAY),
      accepted_at: null,
      accepted_by: null,
      revoked_at: null,
    };
    assert.equal(toInvitation(row, T0).state, 'pending');
    assert.equal(toInvitation(row, new Date(T0.getTime() + DAY)).state, 'expired');
  });
});

const harness = await setupDatabase();

describeDb('invitations', harness, ({ db }) => {
  let now = T0;
  const { mailer, sent } = memoryInvitationMailer();
  const tenancy = createTenancy({ db, clock: () => now, invitationMailer: mailer });
  let tenantId: string;

  before(async () => {
    tenantId = (await tenancy.createTenant({ slug: 'inv', name: 'Inv', owner: 'owner-1' })).id;
  });

  it('issues a token once, stores only its hash, and mails it', async () => {
    const { invitation, token } = await tenancy.invitations.invite({
      tenantId,
      email: 'Dev@Example.com ',
      role: 'member',
      invitedBy: 'owner-1',
    });
    assert.equal(invitation.state, 'pending');
    assert.equal(invitation.email, 'dev@example.com', 'lower-cased and trimmed');
    assert.equal(invitation.expiresAt.getTime(), T0.getTime() + 7 * DAY);
    assert.ok(token.length >= 40);

    const rows = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM tenancy.invitations WHERE id = $1',
      [invitation.id],
    );
    assert.equal(rows[0].token_hash, hashInvitationToken(token));
    assert.notEqual(rows[0].token_hash, token, 'the clear text never touches the table');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'invite');
    assert.equal(sent[0].token, token);
    assert.equal(sent[0].tenant.slug, 'inv');
    assert.equal(sent[0].invitation.id, invitation.id);
  });

  it('accepts into a membership; the same user accepting twice is idempotent', async () => {
    const { token, invitation } = await tenancy.invitations.invite({
      tenantId,
      email: 'twice@example.com',
      role: 'admin',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    const first = await tenancy.invitations.accept({ token, userId: 'user-twice' });
    assert.equal(first.membership.role, 'admin');
    assert.equal(first.invitation.state, 'accepted');
    assert.equal(first.invitation.acceptedBy, 'user-twice');

    const second = await tenancy.invitations.accept({ token, userId: 'user-twice' });
    assert.deepEqual(second.membership, first.membership);
    assert.equal(second.invitation.id, invitation.id);
    assert.equal((await tenancy.getMembership(tenantId, 'user-twice')).role, 'admin');
  });

  it('a different user presenting an accepted token gets invitation_taken', async () => {
    const { token } = await tenancy.invitations.invite({
      tenantId,
      email: 'taken@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    await tenancy.invitations.accept({ token, userId: 'user-first' });
    await assert.rejects(
      tenancy.invitations.accept({ token, userId: 'user-second' }),
      (e: unknown) =>
        TenancyError.hasCode(e, 'invitation_taken') && e.failure.acceptedBy === 'user-first',
    );
    await assert.rejects(tenancy.getMembership(tenantId, 'user-second'), (e: unknown) =>
      TenancyError.hasCode(e, 'not_a_member'),
    );
  });

  it('two users racing one token: one member, one invitation_taken', async () => {
    const { token } = await tenancy.invitations.invite({
      tenantId,
      email: 'race@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    const results = await Promise.allSettled([
      tenancy.invitations.accept({ token, userId: 'racer-a' }),
      tenancy.invitations.accept({ token, userId: 'racer-b' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(TenancyError.hasCode((bad[0] as PromiseRejectedResult).reason, 'invitation_taken'));
  });

  it('revoked tokens fail with invitation_revoked; revoke is idempotent', async () => {
    const { token, invitation } = await tenancy.invitations.invite({
      tenantId,
      email: 'revoked@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    const revoked = await tenancy.invitations.revoke(invitation.id);
    assert.equal(revoked.state, 'revoked');
    assert.deepEqual(await tenancy.invitations.revoke(invitation.id), revoked);
    await assert.rejects(tenancy.invitations.accept({ token, userId: 'user-x' }), (e: unknown) =>
      TenancyError.hasCode(e, 'invitation_revoked'),
    );
    await assert.rejects(tenancy.invitations.resend(invitation.id), (e: unknown) =>
      TenancyError.hasCode(e, 'invitation_revoked'),
    );
  });

  it('an accepted invitation cannot be revoked or resent', async () => {
    const { token, invitation } = await tenancy.invitations.invite({
      tenantId,
      email: 'done@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    await tenancy.invitations.accept({ token, userId: 'user-done' });
    await assert.rejects(tenancy.invitations.revoke(invitation.id), (e: unknown) =>
      TenancyError.hasCode(e, 'invitation_taken'),
    );
    await assert.rejects(tenancy.invitations.resend(invitation.id), (e: unknown) =>
      TenancyError.hasCode(e, 'invitation_taken'),
    );
  });

  it('expired tokens fail with invitation_expired, before and after the sweep', async () => {
    const { token, invitation } = await tenancy.invitations.invite({
      tenantId,
      email: 'late@example.com',
      role: 'member',
      invitedBy: 'owner-1',
      ttlMs: DAY,
    });
    now = new Date(T0.getTime() + DAY); // exactly at expiry: expired
    try {
      assert.equal((await tenancy.invitations.get(invitation.id)).state, 'expired');
      await assert.rejects(
        tenancy.invitations.accept({ token, userId: 'user-late' }),
        (e: unknown) =>
          TenancyError.hasCode(e, 'invitation_expired') &&
          e.failure.expiresAt.getTime() === T0.getTime() + DAY,
      );
      const swept = await tenancy.invitations.sweepExpired();
      assert.equal(swept, 1, 'only this one had timed out');
      assert.equal(await tenancy.invitations.sweepExpired(), 0, 'sweep is idempotent');
      const rows = await db.query<{ state: string }>(
        'SELECT state FROM tenancy.invitations WHERE id = $1',
        [invitation.id],
      );
      assert.equal(rows[0].state, 'expired', 'stored, not just derived');
      await assert.rejects(
        tenancy.invitations.accept({ token, userId: 'user-late' }),
        (e: unknown) => TenancyError.hasCode(e, 'invitation_expired'),
      );

      // resend revives it with a new token and expiry; the old token is dead.
      const resent = await tenancy.invitations.resend(invitation.id);
      assert.equal(resent.invitation.state, 'pending');
      assert.equal(resent.invitation.expiresAt.getTime(), now.getTime() + 7 * DAY);
      assert.notEqual(resent.token, token);
      assert.equal(sent.at(-1)?.kind, 'resend');
      await assert.rejects(
        tenancy.invitations.accept({ token, userId: 'user-late' }),
        (e: unknown) => TenancyError.hasCode(e, 'unknown_invitation'),
      );
      const accepted = await tenancy.invitations.accept({
        token: resent.token,
        userId: 'user-late',
      });
      assert.equal(accepted.membership.role, 'member');
    } finally {
      now = T0;
    }
  });

  it('a tampered or unknown token is unknown_invitation, and so is an unknown id', async () => {
    const { token } = await tenancy.invitations.invite({
      tenantId,
      email: 'tamper@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await assert.rejects(
      tenancy.invitations.accept({ token: flipped, userId: 'user-t' }),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_invitation'),
    );
    await assert.rejects(tenancy.invitations.get('nope'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_invitation'),
    );
    await assert.rejects(tenancy.invitations.revoke('nope'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_invitation'),
    );
    await assert.rejects(tenancy.invitations.resend('nope'), (e: unknown) =>
      TenancyError.hasCode(e, 'unknown_invitation'),
    );
  });

  it('re-inviting an address supersedes the pending invitation', async () => {
    const first = await tenancy.invitations.invite({
      tenantId,
      email: 'again@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    const second = await tenancy.invitations.invite({
      tenantId,
      email: 'AGAIN@example.com',
      role: 'admin',
      invitedBy: 'owner-1',
    });
    assert.notEqual(first.invitation.id, second.invitation.id);
    assert.equal((await tenancy.invitations.get(first.invitation.id)).state, 'revoked');
    await assert.rejects(
      tenancy.invitations.accept({ token: first.token, userId: 'user-again' }),
      (e: unknown) => TenancyError.hasCode(e, 'invitation_revoked'),
    );
    const pending = await tenancy.invitations.list(tenantId, { state: 'pending' });
    assert.equal(pending.filter((i) => i.email === 'again@example.com').length, 1);
  });

  it('concurrent invites for one address leave exactly one pending', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        tenancy.invitations.invite({
          tenantId,
          email: 'storm@example.com',
          role: 'member',
          invitedBy: 'owner-1',
        }),
      ),
    );
    assert.equal(new Set(results.map((r) => r.invitation.id)).size, 6);
    const all = await tenancy.invitations.list(tenantId);
    const storm = all.filter((i) => i.email === 'storm@example.com');
    assert.equal(storm.length, 6);
    assert.equal(storm.filter((i) => i.state === 'pending').length, 1);
  });

  it('list is ordered by issue and filters on effective state', async () => {
    const all = await tenancy.invitations.list(tenantId);
    assert.ok(all.length >= 10);
    for (let i = 1; i < all.length; i++)
      assert.ok(all[i - 1].createdAt.getTime() <= all[i].createdAt.getTime());
    const accepted = await tenancy.invitations.list(tenantId, { state: 'accepted' });
    assert.ok(accepted.every((i) => i.state === 'accepted' && i.acceptedBy !== null));
  });

  it('accepting as an existing member with a different role is already_a_member', async () => {
    const { token } = await tenancy.invitations.invite({
      tenantId,
      email: 'owner-again@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    await assert.rejects(tenancy.invitations.accept({ token, userId: 'owner-1' }), (e: unknown) =>
      TenancyError.hasCode(e, 'already_a_member'),
    );
    // Same role as held: idempotent, and the invitation is consumed.
    const { token: sameRole } = await tenancy.invitations.invite({
      tenantId,
      email: 'owner-same@example.com',
      role: 'owner',
      invitedBy: 'owner-1',
    });
    const out = await tenancy.invitations.accept({ token: sameRole, userId: 'owner-1' });
    assert.equal(out.invitation.state, 'accepted');
  });

  it('validates input and refuses archived tenants', async () => {
    const base = { tenantId, role: 'member' as const, invitedBy: 'owner-1' };
    await assert.rejects(
      tenancy.invitations.invite({ ...base, email: 'not-an-address' }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'email',
    );
    await assert.rejects(
      tenancy.invitations.invite({ ...base, email: 'a@b.c', invitedBy: ' ' }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'invitedBy',
    );
    await assert.rejects(
      tenancy.invitations.invite({ ...base, email: 'a@b.c', ttlMs: 0 }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'ttlMs',
    );
    await assert.rejects(
      tenancy.invitations.invite({ ...base, email: 'a@b.c', role: 'God!' }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_role'),
    );
    await assert.rejects(
      tenancy.invitations.invite({ ...base, email: 'a@b.c', role: 'god' }),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_role') && e.failure.role === 'god',
    );
    await assert.rejects(
      tenancy.invitations.accept({ token: 'x', userId: '' }),
      (e: unknown) => TenancyError.hasCode(e, 'invalid_tenant') && e.failure.field === 'userId',
    );
    await assert.rejects(
      tenancy.invitations.invite({ ...base, tenantId: 'nope', email: 'a@b.c' }),
      (e: unknown) => TenancyError.hasCode(e, 'unknown_tenant'),
    );

    const gone = await tenancy.createTenant({ slug: 'gone', name: 'Gone', owner: 'owner-1' });
    const { token } = await tenancy.invitations.invite({
      tenantId: gone.id,
      email: 'late@gone.example',
      role: 'member',
      invitedBy: 'owner-1',
    });
    await tenancy.archiveTenant(gone.id);
    await assert.rejects(
      tenancy.invitations.invite({ ...base, tenantId: gone.id, email: 'a@b.c' }),
      (e: unknown) => TenancyError.hasCode(e, 'tenant_archived'),
    );
    await assert.rejects(tenancy.invitations.accept({ token, userId: 'u' }), (e: unknown) =>
      TenancyError.hasCode(e, 'tenant_archived'),
    );
  });

  it('works without a mailer, and a failing mailer leaves the invitation resendable', async () => {
    const quiet = createTenancy({ db, clock: () => now });
    const { token, invitation } = await quiet.invitations.invite({
      tenantId,
      email: 'quiet@example.com',
      role: 'member',
      invitedBy: 'owner-1',
    });
    assert.ok(token);

    const loud = createTenancy({
      db,
      clock: () => now,
      invitationMailer: async () => {
        throw new Error('smtp down');
      },
    });
    await assert.rejects(
      loud.invitations.invite({
        tenantId,
        email: 'unlucky@example.com',
        role: 'member',
        invitedBy: 'owner-1',
      }),
      /smtp down/,
    );
    const pending = await quiet.invitations.list(tenantId, { state: 'pending' });
    const unlucky = pending.find((i) => i.email === 'unlucky@example.com');
    assert.ok(unlucky, 'the row was committed before the mailer ran');
    const resent = await quiet.invitations.resend(unlucky.id);
    assert.equal(resent.invitation.id, unlucky.id);
    assert.equal(resent.invitation.state, 'pending');
    assert.equal(invitation.state, 'pending');
  });
});
