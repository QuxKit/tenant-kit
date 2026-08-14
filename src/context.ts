// The ambient tenant: AsyncLocalStorage, held by an instance rather than by
// this module.
//
// A module-level store is a global, and the library's rule (inherited from
// billing-kit) is that two instances must coexist in one process — a test
// suite scoping tenants over a rolled-back executor while the app scopes its
// own, a worker serving two shards. So `TenantScope` is a class; `createTenancy`
// makes one and threads it through. The free functions in this file take the
// scope as their first argument for anyone composing without the instance.
//
// What goes *in* the context is the resolved fact, not request data: a
// `TenantContext` gets there only via `run`, whose argument is a
// `ResolvedTenant` (membership already checked) or a bare `TenantId` for
// background work that owns its tenant choice — a queue consumer replaying a
// job that recorded its tenant, a sweep iterating tenants it just listed.
// There is deliberately no `set()`; a context you can mutate mid-request is a
// context whose reads you cannot reason about.

import { AsyncLocalStorage } from 'node:async_hooks';
import { TenancyError } from './errors.ts';
import type { ResolvedTenant, TenantContext, TenantId } from './types.ts';

export class TenantScope {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  /**
   * Run `fn` with the tenant ambient. Everything `fn` awaits inherits the
   * context; nothing outside the call sees it. Nesting is allowed and the
   * inner tenant wins for its extent — that is `AsyncLocalStorage` semantics,
   * and it is what a support tool impersonating into a second tenant needs.
   */
  run<T>(scope: ResolvedTenant | TenantId, fn: () => T): T {
    const context: TenantContext =
      typeof scope === 'string'
        ? { tenantId: scope }
        : { tenantId: scope.tenant.id, tenant: scope.tenant, membership: scope.membership };
    return this.storage.run(context, fn);
  }

  /** The ambient context, or null outside any `run`. */
  current(): TenantContext | null {
    return this.storage.getStore() ?? null;
  }

  /**
   * The ambient context, or a thrown `no_tenant_context`. For code paths that
   * are wrong to reach untenanted — which is most of them, in a multi-tenant
   * app. Prefer this over `current()` plus a null check that each call site
   * words differently.
   */
  require(): TenantContext {
    const context = this.storage.getStore();
    if (context === undefined) throw new TenancyError({ code: 'no_tenant_context' });
    return context;
  }
}
