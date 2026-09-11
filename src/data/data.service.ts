import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { TableWriterService } from '../db/table-writer.service';

/**
 * Generic, RLS-scoped CRUD for tables in the data-layer registry — server
 * side of what crmApi.ts's persistInsert/persistUpdate/persistDelete/
 * persistUpdateWhere/persistDeleteWhere used to do directly against
 * PostgREST. See db/table-registry.ts for which tables/columns are exposed.
 */
@Injectable()
export class DataService {
  constructor(
    private readonly db: DatabaseService,
    private readonly writer: TableWriterService,
  ) {}

  insert(authUid: string, table: string, row: Record<string, unknown>) {
    return this.db.withCaller(authUid, (client) =>
      this.writer.insert(client, table, row),
    );
  }

  async update(
    authUid: string,
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const row = await this.writer.update(client, table, id, patch);
      if (!row) throw new NotFoundException(`${table}/${id} not found`);
      return row;
    });
  }

  updateWhere(
    authUid: string,
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    return this.db.withCaller(authUid, (client) =>
      this.writer.updateWhere(client, table, match, patch),
    );
  }

  delete(authUid: string, table: string, id: string) {
    return this.db.withCaller(authUid, (client) =>
      this.writer.delete(client, table, id),
    );
  }

  deleteWhere(authUid: string, table: string, match: Record<string, unknown>) {
    return this.db.withCaller(authUid, (client) =>
      this.writer.deleteWhere(client, table, match),
    );
  }

  async getOne(authUid: string, table: string, id: string) {
    return this.db.withCaller(authUid, async (client) => {
      const row = await this.writer.getOne(client, table, id);
      if (!row) throw new NotFoundException(`${table}/${id} not found`);
      return row;
    });
  }
}
