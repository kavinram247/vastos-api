import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { assertIdent, getTableSpec } from './table-registry';

/**
 * Generic, RLS-scoped CRUD over the tables listed in table-registry.ts — the
 * server-side equivalent of what supabase-js's `.from(table).insert/update/
 * delete()` did for the frontend's crmApi.ts. Every call runs inside a
 * DatabaseService.withCaller() transaction, so `firm_id = current_firm_id()`
 * (and every other RLS policy) is exactly as enforced as it always was.
 *
 * Table/column names are validated against the registry BEFORE interpolation
 * (SQL doesn't let you parameterize identifiers); values are always sent as
 * query parameters, never string-built.
 */
@Injectable()
export class TableWriterService {
  async insert<T extends QueryResultRow = QueryResultRow>(
    client: PoolClient,
    table: string,
    row: Record<string, unknown>,
  ): Promise<T> {
    const spec = getTableSpec(table);
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    this.assertColumns(spec, cols);
    if (cols.length === 0) throw new BadRequestException('empty row');

    const colList = cols.map(assertIdent).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = cols.map((c) => row[c]);

    const { rows } = await client.query<T>(
      `insert into ${assertIdent(table)} (${colList}) values (${placeholders}) returning *`,
      values,
    );
    return rows[0];
  }

  async update<T extends QueryResultRow = QueryResultRow>(
    client: PoolClient,
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<T | undefined> {
    const spec = getTableSpec(table);
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    this.assertColumns(spec, cols);
    if (cols.length === 0) throw new BadRequestException('empty patch');

    const setList = cols
      .map((c, i) => `${assertIdent(c)} = $${i + 1}`)
      .join(', ');
    const values = cols.map((c) => patch[c]);

    const { rows } = await client.query<T>(
      `update ${assertIdent(table)} set ${setList} where id = $${cols.length + 1} returning *`,
      [...values, id],
    );
    return rows[0];
  }

  /** Update every row matching `match` (an AND of equality filters). */
  async updateWhere(
    client: PoolClient,
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const spec = getTableSpec(table);
    const patchCols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    const matchCols = Object.keys(match);
    this.assertColumns(spec, patchCols);
    this.assertFilterable(spec, matchCols);
    if (patchCols.length === 0 || matchCols.length === 0) {
      throw new BadRequestException('empty patch or match');
    }

    const setList = patchCols
      .map((c, i) => `${assertIdent(c)} = $${i + 1}`)
      .join(', ');
    const whereList = matchCols
      .map((c, i) => `${assertIdent(c)} = $${patchCols.length + i + 1}`)
      .join(' and ');
    const values = [
      ...patchCols.map((c) => patch[c]),
      ...matchCols.map((c) => match[c]),
    ];

    const res = await client.query(
      `update ${assertIdent(table)} set ${setList} where ${whereList}`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async delete(client: PoolClient, table: string, id: string): Promise<number> {
    getTableSpec(table); // validates the table itself
    const res = await client.query(
      `delete from ${assertIdent(table)} where id = $1`,
      [id],
    );
    return res.rowCount ?? 0;
  }

  /** Delete every row matching `match` (an AND of equality filters). */
  async deleteWhere(
    client: PoolClient,
    table: string,
    match: Record<string, unknown>,
  ): Promise<number> {
    const spec = getTableSpec(table);
    const matchCols = Object.keys(match);
    this.assertFilterable(spec, matchCols);
    if (matchCols.length === 0) throw new BadRequestException('empty match');

    const whereList = matchCols
      .map((c, i) => `${assertIdent(c)} = $${i + 1}`)
      .join(' and ');
    const values = matchCols.map((c) => match[c]);

    const res = await client.query(
      `delete from ${assertIdent(table)} where ${whereList}`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async getOne<T extends QueryResultRow = QueryResultRow>(
    client: PoolClient,
    table: string,
    id: string,
  ): Promise<T | undefined> {
    getTableSpec(table);
    const { rows } = await client.query<T>(
      `select * from ${assertIdent(table)} where id = $1 limit 1`,
      [id],
    );
    return rows[0];
  }

  private assertColumns(spec: { columns: Set<string> }, cols: string[]) {
    for (const c of cols) {
      if (!spec.columns.has(c)) {
        throw new BadRequestException(
          `column "${c}" is not writable on this table`,
        );
      }
    }
  }

  private assertFilterable(spec: { filterable: Set<string> }, cols: string[]) {
    for (const c of cols) {
      if (!spec.filterable.has(c)) {
        throw new BadRequestException(
          `column "${c}" is not filterable on this table`,
        );
      }
    }
  }
}
