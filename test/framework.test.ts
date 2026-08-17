// The framework helpers, driven with fake requests against a real Postgres:
// each one must resolve, scope (context or transaction), and map failures
// the same way — 401 unauthenticated, 400 no claim, 404 for anything that
// would reveal a tenant's existence, 403 forbidden.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { TenancyError } from '../src/errors.ts';
import { tenantMiddleware as expressTenant, tenantHandler } from '../src/express.ts';
import { defaultFailureResponse, resolveForRequest } from '../src/framework/http.ts';
import { tenantMiddleware as honoTenant } from '../src/hono.ts';
import { createTenancy } from '../src/instance.ts';
import { withTenant as nextTenant } from '../src/next.ts';
import { fromHeader, fromSubdomain } from '../src/resolve.ts';
import type { ResolvedTenant, SqlExecutor } from '../src/types.ts';
import { describeDb, type Harness, setupAppRole, setupDatabase } from './harness.ts';

describe('defaultFailureResponse', () => {
  it('maps every tenancy code to a status; existence-revealing ones to 404', () => {
    const of = (code: Parameters<typeof TenancyError.hasCode>[1]) =>
      defaultFailureResponse({
        kind: 'tenancy',
        error: new TenancyError({ code, ref: 'x' } as never),
      }).status;
    assert.equal(defaultFailureResponse({ kind: 'unauthenticated' }).status, 401);
    assert.equal(of('no_tenant_claim'), 400);
    assert.equal(of('unknown_tenant'), 404);
    assert.equal(of('not_a_member'), 404);
    assert.equal(of('tenant_archived'), 404);
    assert.equal(of('forbidden'), 403);
    assert.equal(of('permission_denied'), 403);
    assert.equal(of('last_owner'), 500);
    const body = defaultFailureResponse({
      kind: 'tenancy',
      error: new TenancyError({ code: 'not_a_member', tenantId: 't', userId: 'u' }),
    }).body;
    assert.equal(body.code, 'unknown_tenant', 'the body does not say which of the three it was');
  });
});

const admin = await setupDatabase();

describeDb('framework helpers', admin, (admin) => {
  let app: Harness;
  let tenancy: ReturnType<typeof createTenancy>;
  let acmeId: string;
  const extract = fromSubdomain({ baseDomain: 'example.com' });
  const users: Record<string, string | null> = {
    'tok-owner': 'owner-1',
    'tok-dev': 'dev-1',
    'tok-out': 'outsider',
  };
  const userIdFromHeaders = (headers: Record<string, string | string[] | undefined>) => {
    const auth = headers.authorization;
    return typeof auth === 'string' ? (users[auth] ?? null) : null;
  };

  before(async () => {
    const role = await setupAppRole(admin);
    if (role === null) throw new Error('the app role could not connect; see setupAppRole');
    app = role;
    // The directory is owned by the admin harness; the app role reads it.
    await admin.pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenancy TO tenant_kit_test_app`,
    );
    await admin.pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA tenancy TO tenant_kit_test_app`);
    tenancy = createTenancy({ db: app.db });
    const acme = await tenancy.createTenant({ slug: 'acme', name: 'Acme', owner: 'owner-1' });
    acmeId = acme.id;
    await tenancy.addMember({ tenantId: acmeId, userId: 'dev-1', role: 'member' });
    await tenancy.createTenant({ slug: 'gone', name: 'Gone', owner: 'owner-1' });
    await tenancy.archiveTenant((await tenancy.getTenantBySlug('gone')).id);
    await app.db.query(
      `CREATE TABLE host.notes (id serial PRIMARY KEY, tenant_id text NOT NULL, body text NOT NULL)`,
    );
    // Seed before protecting: the whole point of FORCE is that even the
    // owner cannot write outside a scope afterwards.
    await app.db.query(`INSERT INTO host.notes (tenant_id, body) VALUES ($1, 'acme note')`, [
      acmeId,
    ]);
    await app.db.query(
      `INSERT INTO host.notes (tenant_id, body) VALUES ('someone-else', 'not yours')`,
    );
    await app.db.query(`SELECT tenancy.protect('host.notes')`);
  });

  // --- express --------------------------------------------------------------

  interface FakeRes {
    statusCode: number;
    body: unknown;
    status(code: number): FakeRes;
    json(body: unknown): FakeRes;
  }
  const fakeRes = (): FakeRes => ({
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  });
  const expressReq = (host: string, auth?: string) => ({
    hostname: host,
    path: '/notes',
    headers: { host, ...(auth ? { authorization: auth } : {}) } as Record<string, string>,
    tenant: undefined as ResolvedTenant | undefined,
  });
  const expressOptions = () => ({
    tenancy,
    extract,
    userId: (req: ReturnType<typeof expressReq>) => userIdFromHeaders(req.headers),
  });
  const runExpress = (
    mw: (req: ReturnType<typeof expressReq>, res: FakeRes, next: (e?: unknown) => void) => void,
    req: ReturnType<typeof expressReq>,
  ) =>
    new Promise<{ res: FakeRes; nextCalled: boolean; nextError: unknown; inside: unknown }>(
      (resolve) => {
        const res = fakeRes();
        let settled = false;
        const done = (
          out: Partial<{ nextCalled: boolean; nextError: unknown; inside: unknown }>,
        ) => {
          if (settled) return;
          settled = true;
          resolve({ res, nextCalled: false, nextError: undefined, inside: undefined, ...out });
        };
        const origJson = res.json.bind(res);
        res.json = (body) => {
          origJson(body);
          done({});
          return res;
        };
        mw(req, res, (error) => {
          if (error !== undefined) return done({ nextCalled: true, nextError: error });
          done({ nextCalled: true, inside: tenancy.current() });
        });
      },
    );

  it('express middleware: resolves, sets req.tenant, runs next inside the tenant context', async () => {
    const mw = expressTenant(expressOptions());
    const req = expressReq('acme.example.com', 'tok-dev');
    const out = await runExpress(mw, req);
    assert.equal(out.nextCalled, true);
    assert.equal(req.tenant?.tenant.slug, 'acme');
    assert.equal(req.tenant?.membership.role, 'member');
    assert.equal((out.inside as { tenantId: string }).tenantId, acmeId, 'ambient inside next()');
  });

  it('express middleware: 401 / 400 / 404 / 403 without calling next', async () => {
    const cases: Array<[string, string | undefined, number]> = [
      ['acme.example.com', undefined, 401],
      ['example.com', 'tok-dev', 400],
      ['nope.example.com', 'tok-dev', 404],
      ['acme.example.com', 'tok-out', 404],
      ['gone.example.com', 'tok-owner', 404],
    ];
    for (const [host, auth, status] of cases) {
      const out = await runExpress(expressTenant(expressOptions()), expressReq(host, auth));
      assert.equal(out.res.statusCode, status, `${host} ${auth}`);
      assert.equal(out.nextCalled, false);
    }
    const forbidden = await runExpress(
      expressTenant({ ...expressOptions(), requireRole: 'admin' }),
      expressReq('acme.example.com', 'tok-dev'),
    );
    assert.equal(forbidden.res.statusCode, 403);
    assert.equal((forbidden.res.body as { code: string }).code, 'forbidden');
    const denied = await runExpress(
      expressTenant({ ...expressOptions(), requirePermission: 'members:write' }),
      expressReq('acme.example.com', 'tok-dev'),
    );
    assert.equal(denied.res.statusCode, 403);
    assert.equal((denied.res.body as { code: string }).code, 'permission_denied');
    const allowed = await runExpress(
      expressTenant({
        ...expressOptions(),
        requirePermission: 'members:write',
        requireRole: 'admin',
      }),
      expressReq('acme.example.com', 'tok-owner'),
    );
    assert.equal(allowed.nextCalled, true);
  });

  it('express middleware: a custom onFailure and a non-tenancy error reaching next(err)', async () => {
    const custom = await runExpress(
      expressTenant({
        ...expressOptions(),
        onFailure: (f) => ({ status: 418, body: { error: f.kind } }),
      }),
      expressReq('acme.example.com'),
    );
    assert.equal(custom.res.statusCode, 418);
    assert.deepEqual(custom.res.body, { error: 'unauthenticated' });

    const boom = await runExpress(
      expressTenant({
        ...expressOptions(),
        userId: () => {
          throw new Error('session store down');
        },
      }),
      expressReq('acme.example.com', 'tok-dev'),
    );
    assert.equal(boom.nextCalled, true);
    assert.match(String((boom.nextError as Error).message), /session store down/);
  });

  it('express tenantHandler: runs inside withTenant with a scoped executor', async () => {
    let seen: string[] = [];
    let ambient: string | undefined;
    const handler = tenantHandler(expressOptions(), async (_req, res, ctx) => {
      seen = (await ctx.db.query<{ body: string }>('SELECT body FROM host.notes')).map(
        (r) => r.body,
      );
      ambient = tenancy.current()?.tenantId;
      assert.equal(ctx.tenant.id, acmeId);
      assert.equal(ctx.membership.userId, 'dev-1');
      res.status(200).json({ notes: seen });
    });
    const out = await runExpress(handler, expressReq('acme.example.com', 'tok-dev'));
    assert.deepEqual(seen, ['acme note'], 'RLS through the handler executor');
    assert.equal(ambient, acmeId);
    assert.deepEqual(out.res.body, { notes: ['acme note'] });

    // A throwing handler rolls the transaction back and reaches next(err).
    const failing = tenantHandler(expressOptions(), async (_req, _res, ctx) => {
      await ctx.db.query(`INSERT INTO host.notes (tenant_id, body) VALUES ($1, 'doomed')`, [
        acmeId,
      ]);
      throw new Error('handler blew up');
    });
    const failed = await runExpress(failing, expressReq('acme.example.com', 'tok-dev'));
    assert.match(String((failed.nextError as Error).message), /handler blew up/);
    const rows = await tenancy.db(acmeId).query<{ body: string }>('SELECT body FROM host.notes');
    assert.deepEqual(
      rows.map((r) => r.body),
      ['acme note'],
    );
    const denied = await runExpress(
      tenantHandler(expressOptions(), async () => {
        throw new Error('must not run');
      }),
      expressReq('acme.example.com', 'tok-out'),
    );
    assert.equal(denied.res.statusCode, 404);
  });

  // --- hono -----------------------------------------------------------------

  const honoCtx = (host: string, auth?: string) => {
    const vars = new Map<string, unknown>();
    const headers: Record<string, string> = { host, ...(auth ? { authorization: auth } : {}) };
    return {
      vars,
      response: undefined as { body: unknown; status?: number } | undefined,
      req: {
        url: `https://${host}/notes`,
        header: ((name?: string) =>
          name === undefined ? headers : headers[name.toLowerCase()]) as {
          (name: string): string | undefined;
          (): Record<string, string>;
        },
      },
      set(key: string, value: unknown) {
        vars.set(key, value);
      },
      json(body: unknown, status?: number) {
        this.response = { body, status };
        return this.response;
      },
    };
  };
  const honoOptions = () => ({
    tenancy,
    extract,
    userId: (c: ReturnType<typeof honoCtx>) => userIdFromHeaders(c.req.header()),
  });

  it('hono middleware: downstream runs inside withTenant with tenant and tenantDb set', async () => {
    const c = honoCtx('acme.example.com', 'tok-dev');
    let seen: string[] = [];
    let ambient: string | undefined;
    await honoTenant(honoOptions())(c, async () => {
      const db = c.vars.get('tenantDb') as SqlExecutor;
      seen = (await db.query<{ body: string }>('SELECT body FROM host.notes')).map((r) => r.body);
      ambient = tenancy.current()?.tenantId;
    });
    assert.deepEqual(seen, ['acme note']);
    assert.equal(ambient, acmeId);
    assert.equal((c.vars.get('tenant') as ResolvedTenant).tenant.slug, 'acme');
    assert.equal(
      c.response,
      undefined,
      'the middleware did not answer; downstream owns the response',
    );
  });

  it('hono middleware: failures answer JSON and skip downstream; handler errors propagate', async () => {
    for (const [host, auth, status] of [
      ['acme.example.com', undefined, 401],
      ['example.com', 'tok-dev', 400],
      ['acme.example.com', 'tok-out', 404],
    ] as const) {
      const c = honoCtx(host, auth);
      let ran = false;
      await honoTenant(honoOptions())(c, async () => {
        ran = true;
      });
      assert.equal(c.response?.status, status);
      assert.equal(ran, false);
    }
    const c = honoCtx('acme.example.com', 'tok-dev');
    await assert.rejects(
      honoTenant({ ...honoOptions(), requireRole: 'member' })(c, async () => {
        throw new Error('downstream failed');
      }),
      /downstream failed/,
    );
    const forbidden = honoCtx('acme.example.com', 'tok-dev');
    await honoTenant({ ...honoOptions(), requireRole: 'owner' })(forbidden, async () => {});
    assert.equal(forbidden.response?.status, 403);
  });

  // --- next -----------------------------------------------------------------

  const nextReq = (host: string, auth?: string) =>
    new Request(`https://${host}/api/notes`, {
      headers: { host, ...(auth ? { authorization: auth } : {}) },
    });
  const nextOptions = () => ({
    tenancy,
    extract,
    userId: (req: Request) => users[req.headers.get('authorization') ?? ''] ?? null,
  });

  it('next withTenant: handler runs inside withTenant and returns its Response', async () => {
    const GET = nextTenant(nextOptions(), async (_req, ctx, route: { params: { id: string } }) => {
      const rows = await ctx.db.query<{ body: string }>('SELECT body FROM host.notes');
      return Response.json({
        notes: rows.map((r) => r.body),
        tenant: ctx.tenant.slug,
        role: ctx.membership.role,
        ambient: tenancy.current()?.tenantId,
        param: route.params.id,
      });
    });
    const res = await GET(nextReq('acme.example.com', 'tok-owner'), { params: { id: '7' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      notes: ['acme note'],
      tenant: 'acme',
      role: 'owner',
      ambient: acmeId,
      param: '7',
    });
  });

  it('next withTenant: failures become JSON responses; the header extractor works too', async () => {
    const GET = nextTenant(nextOptions(), async () => Response.json({ ok: true }));
    assert.equal((await GET(nextReq('acme.example.com'), {})).status, 401);
    assert.equal((await GET(nextReq('nope.example.com', 'tok-dev'), {})).status, 404);
    assert.equal((await GET(nextReq('example.com', 'tok-dev'), {})).status, 400);
    const forbidden = nextTenant({ ...nextOptions(), requireRole: 'admin' }, async () =>
      Response.json({ ok: true }),
    );
    const res = await forbidden(nextReq('acme.example.com', 'tok-dev'), {});
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'forbidden', code: 'forbidden' });

    const byHeader = nextTenant(
      { ...nextOptions(), extract: fromHeader('x-tenant') },
      async (_r, ctx) => Response.json({ slug: ctx.tenant.slug }),
    );
    const req = new Request('https://api.example.com/x', {
      headers: { authorization: 'tok-dev', 'x-tenant': 'acme' },
    });
    assert.deepEqual(await (await byHeader(req, {})).json(), { slug: 'acme' });
  });

  it('resolveForRequest: an empty user id is unauthenticated', async () => {
    const out = await resolveForRequest(
      { tenancy, extract, userId: () => '' },
      {},
      { hostname: 'acme.example.com' },
    );
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.failure.kind, 'unauthenticated');
  });
});
