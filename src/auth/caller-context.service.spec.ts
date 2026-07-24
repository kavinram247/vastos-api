import { Test } from '@nestjs/testing';
import { CallerContextService } from './caller-context.service';
import { SupabaseService } from '../supabase/supabase.service';

type Row = Record<string, unknown> | null;

interface MockQuery {
  select: (columns: string) => MockQuery;
  eq: (column: string, value: string) => MockQuery;
  maybeSingle: () => Promise<{ data: Row; error: null }>;
}

function makeQuery(row: Row): MockQuery {
  const query: MockQuery = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return query;
}

function makeDb(rows: {
  profile: Row;
  crmProfile: Row;
  role: Row;
  permissions: Row;
}): { from: (table: string) => MockQuery } {
  return {
    from: (table: string) => {
      if (table === 'profiles') return makeQuery(rows.profile);
      if (table === 'crm_profiles') return makeQuery(rows.crmProfile);
      if (table === 'crm_roles') return makeQuery(rows.role);
      if (table === 'crm_role_permissions') return makeQuery(rows.permissions);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

async function build(rows: {
  profile: Row;
  crmProfile: Row;
  role: Row;
  permissions: Row;
}) {
  const supabase = {
    getServiceRoleClient: () => makeDb(rows),
  } as unknown as SupabaseService;

  const moduleRef = await Test.createTestingModule({
    providers: [
      CallerContextService,
      { provide: SupabaseService, useValue: supabase },
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
