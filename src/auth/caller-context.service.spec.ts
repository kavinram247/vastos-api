import { Test } from '@nestjs/testing';
import { CallerContextService } from './caller-context.service';
import { DatabaseService } from '../db/database.service';

type Row = Record<string, unknown> | null;

function makeClient(rows: {
  profile: Row;
  crmProfile: Row;
  role: Row;
  permissions: Row;
}) {
  return {
    query: async (sql: string) => {
      if (sql.includes('from profiles')) return { rows: rows.profile ? [rows.profile] : [] };
      if (sql.includes('from crm_profiles')) return { rows: rows.crmProfile ? [rows.crmProfile] : [] };
      if (sql.includes('from crm_roles')) return { rows: rows.role ? [rows.role] : [] };
      if (sql.includes('from crm_role_permissions')) return { rows: rows.permissions ? [rows.permissions] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function build(rows: {
  profile: Row;
  crmProfile: Row;
  role: Row;
  permissions: Row;
}) {
  const db = {
    withServiceRole: (fn: (client: unknown) => Promise<unknown>) => fn(makeClient(rows)),
  } as unknown as DatabaseService;

  const moduleRef = await Test.createTestingModule({
    providers: [
      CallerContextService,
      { provide: DatabaseService, useValue: db },
    ],
  }).compile();

  return moduleRef.get(CallerContextService);
}

const AUTH_USER = { id: 'auth-uid-1', email: 'user@example.com' };

describe('CallerContextService', () => {
  it('returns null when no profiles row matches the auth uid', async () => {
    const service = await build({
      profile: null,
      crmProfile: null,
      role: null,
      permissions: null,
    });
    expect(await service.resolve(AUTH_USER)).toBeNull();
  });

  it('is read-only when the crm_profiles row has no role_id', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: null },
      role: null,
      permissions: null,
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx).toEqual({
      firmId: 'firm-1',
      crmProfileId: 'cp1',
      isReadOnlyViewer: true,
      isAdmin: false,
    });
  });

  it('is read-only when the role is disabled', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'all', is_admin: false, enabled: false },
      permissions: { actions: ['create'] },
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(true);
  });

  it('admin roles are never read-only, regardless of scope', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'own', is_admin: true, enabled: true },
      permissions: null,
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(false);
  });

  it('scope=own is read-only even with documents:create granted', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'own', is_admin: false, enabled: true },
      permissions: { actions: ['create', 'view'] },
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(true);
  });

  it('scope=all without documents:create is read-only', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'all', is_admin: false, enabled: true },
      permissions: { actions: ['view'] },
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(true);
  });

  it('scope=all with documents:create is NOT read-only', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'all', is_admin: false, enabled: true },
      permissions: { actions: ['view', 'create'] },
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(false);
  });

  it('missing crm_role_permissions row defaults actions to empty (read-only)', async () => {
    const service = await build({
      profile: { id: 'p1', firm_id: 'firm-1', email: AUTH_USER.email },
      crmProfile: { id: 'cp1', role_id: 'role-1' },
      role: { scope: 'all', is_admin: false, enabled: true },
      permissions: null,
    });
    const ctx = await service.resolve(AUTH_USER);
    expect(ctx?.isReadOnlyViewer).toBe(true);
  });
});
