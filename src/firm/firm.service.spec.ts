import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import { FirmService } from './firm.service';

// A fake PoolClient that answers each query by matching a fragment of its SQL.
function fakeClient(handlers: Array<[RegExp, unknown[]]>): PoolClient {
  return {
    query: (text: string) => {
      const hit = handlers.find(([re]) => re.test(text));
      return Promise.resolve({ rows: hit ? hit[1] : [] });
    },
  } as unknown as PoolClient;
}

function dbWith(client: PoolClient): DatabaseService {
  return {
    withCaller: <T>(_uid: string, fn: (c: PoolClient) => Promise<T>) =>
      fn(client),
  } as unknown as DatabaseService;
}

describe('FirmService.bootstrap', () => {
  it('throws Forbidden when the account has no profile', async () => {
    const svc = new FirmService(dbWith(fakeClient([[/from profiles/, []]])));
    await expect(svc.bootstrap('uid-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('assembles session + firm-keyed data, resolving role_id from crm_profiles', async () => {
    const client = fakeClient([
      [
        /from profiles\s/,
        [
          {
            id: 'p1',
            firm_id: 'f1',
            email: 'Owner@Firm.test',
            full_name: 'Owner',
            role: 'owner',
            phone: null,
            avatar_url: null,
            created_at: 't',
          },
        ],
      ],
      [
        /from firms/,
        [
          {
            id: 'f1',
            name: 'Firm One',
            address: null,
            logo_url: null,
            gstin: null,
            payment_split_default: 3,
            created_at: 't',
            deleted_at: null,
          },
        ],
      ],
      [/from firm_subscriptions/, []],
      [/is_vastos_operator/, [{ ok: false }]],
      [
        /json_agg/,
        [
          {
            profiles: [
              { email: 'owner@firm.test', firm_id: 'f1', role_id: 'role-1' },
            ],
            projects: [{ id: 'proj-1' }],
          },
        ],
      ],
    ]);

    const payload = await new FirmService(dbWith(client)).bootstrap('uid-1');

    expect(payload.session.profile.role_id).toBe('role-1');
    expect(payload.session.firm.name).toBe('Firm One');
    expect(payload.session.plan).toBeNull();
    expect(payload.session.isVastosOperator).toBe(false);
    expect(payload.data.projects).toHaveLength(1);
    // every store key present, even when the column was absent from the row
    expect(Object.keys(payload.data)).toContain('dashboardLayouts');
    expect(payload.data.dashboardLayouts).toEqual([]);
  });

  it('rejects a firm that has been closed', async () => {
    const client = fakeClient([
      [
        /from profiles\s/,
        [
          {
            id: 'p1',
            firm_id: 'f1',
            email: 'o@f.test',
            full_name: 'O',
            role: 'owner',
            phone: null,
            avatar_url: null,
            created_at: 't',
          },
        ],
      ],
      [
        /from firms/,
        [{ id: 'f1', name: 'X', payment_split_default: 3, deleted_at: 't' }],
      ],
    ]);
    await expect(
      new FirmService(dbWith(client)).bootstrap('uid-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
