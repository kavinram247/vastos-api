import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { TableWriterService } from './table-writer.service';

// A fake PoolClient that records every query and answers with one canned row.
function recordingClient() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve({ rows: [{ id: 'row-1' }], rowCount: 1 });
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe('TableWriterService', () => {
  const writer = new TableWriterService();

  it('sends a jsonb array as JSON text with a ::jsonb cast', async () => {
    const { client, calls } = recordingClient();
    await writer.insert(client, 'tasks', {
      firm_id: 'f1',
      title: 't',
      attachments: [{ name: 'a', url: 'u' }],
    });
    expect(calls[0].text).toBe(
      'insert into tasks (firm_id, title, attachments) values ($1, $2, $3::jsonb) returning *',
    );
    expect(calls[0].values).toEqual(['f1', 't', '[{"name":"a","url":"u"}]']);
  });

  it('keeps an empty jsonb array an array instead of {}', async () => {
    const { client, calls } = recordingClient();
    await writer.update(client, 'tasks', 'id-1', { attachments: [] });
    expect(calls[0].text).toBe(
      'update tasks set attachments = $1::jsonb where id = $2 returning *',
    );
    expect(calls[0].values).toEqual(['[]', 'id-1']);
  });

  it('leaves text[] columns as real arrays and SQL NULL as null', async () => {
    const { client, calls } = recordingClient();
    await writer.update(client, 'crm_contacts', 'c-1', { tags: ['vip'], notes: null });
    expect(calls[0].text).toBe(
      'update crm_contacts set tags = $1, notes = $2 where id = $3 returning *',
    );
    expect(calls[0].values).toEqual([['vip'], null, 'c-1']);
  });

  it('casts jsonb in an updateWhere patch but not in its IN-list match', async () => {
    const { client, calls } = recordingClient();
    await writer.updateWhere(
      client,
      'crm_dashboard_layouts',
      { id: ['a', 'b'] },
      { config: { widgets: [] } },
    );
    expect(calls[0].text).toBe(
      'update crm_dashboard_layouts set config = $1::jsonb where id = ANY ($2)',
    );
    expect(calls[0].values).toEqual(['{"widgets":[]}', ['a', 'b']]);
  });

  it('rejects a column that is not registered', async () => {
    const { client, calls } = recordingClient();
    await expect(
      writer.update(client, 'crm_profiles', 'p-1', { is_admin: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });
});
