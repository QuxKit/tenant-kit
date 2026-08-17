// Per-tenant settings: a jsonb object on the tenant row, patched by JSON
// merge patch.
//
// Merge patch (RFC 7396) is the shape because it is the one callers already
// mean when they say "update the settings": objects merge recursively, any
// other value replaces, and `null` deletes the key. A whole-document PUT
// clobbers what a concurrent caller just wrote; a JSON Patch operation list
// is more than a settings bag needs. Merge patch is what a form submit
// naturally produces.
//
// The size cap is the one refusal here. Settings are read on hot paths
// (every request that needs a flag), and a jsonb column nobody bounded is
// how a tenant ends up with a 40 MB "settings" blob that a UI once wrote a
// base64 image into. The default is 64 KiB; `settingsMaxBytes` on the
// instance changes it.

import { TenancyError } from './errors.ts';
import { type MutationMeta, record } from './events.ts';
import type { SqlExecutor, TenantId } from './types.ts';

export type Settings = Record<string, unknown>;

/** 64 KiB of serialized JSON, unless the instance says otherwise. */
export const DEFAULT_SETTINGS_MAX_BYTES = 64 * 1024;

export interface SettingsOptions {
  maxBytes?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * RFC 7396: apply `patch` to `target`. Pure, and exported because a client
 * that wants to preview the result should compute it the same way. Arrays
 * replace wholesale — that is the RFC, and the reason merge patch is not
 * for list-shaped settings.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

export async function getSettings(db: SqlExecutor, tenantId: TenantId): Promise<Settings> {
  const rows = await db.query<{ settings: Settings }>(
    `SELECT settings FROM tenancy.tenants WHERE id = $1`,
    [tenantId],
  );
  if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: tenantId });
  return rows[0].settings;
}

/**
 * Apply a merge patch under a row lock and return the result. Refuses a
 * result larger than the cap with `settings_too_large` (carrying both
 * numbers) before writing anything. A patch that changes nothing writes no
 * event. `undefined` values in the patch are ignored (JSON has no
 * undefined; treating it as delete would make `{ flag: maybe }` a foot-gun).
 */
export async function patchSettings(
  db: SqlExecutor,
  tenantId: TenantId,
  patch: Settings,
  now: Date,
  options: SettingsOptions = {},
  meta?: MutationMeta,
): Promise<Settings> {
  if (!isPlainObject(patch))
    throw new TenancyError({
      code: 'invalid_tenant',
      field: 'settings',
      reason: 'patch must be an object',
    });
  const maxBytes = options.maxBytes ?? DEFAULT_SETTINGS_MAX_BYTES;
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ settings: Settings }>(
      `SELECT settings FROM tenancy.tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );
    if (rows.length === 0) throw new TenancyError({ code: 'unknown_tenant', ref: tenantId });
    const before = rows[0].settings;
    const after = mergePatch(before, JSON.parse(JSON.stringify(patch))) as Settings;
    const serialized = JSON.stringify(after);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxBytes)
      throw new TenancyError({ code: 'settings_too_large', tenantId, bytes, maxBytes });
    if (serialized === JSON.stringify(before)) return before;
    await tx.query(`UPDATE tenancy.tenants SET settings = $2::jsonb WHERE id = $1`, [
      tenantId,
      serialized,
    ]);
    await record(tx, {
      tenantId,
      type: 'settings_patched',
      payload: { keys: Object.keys(patch) },
      target: tenantId,
      at: now,
      meta,
    });
    return after;
  });
}
