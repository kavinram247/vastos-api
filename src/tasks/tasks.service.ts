import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * The five list reads Vastos_ARC's src/lib/taskApi.ts needs, none of which
 * fit the generic /api/data/:table layer (it only ever does get-one-by-id,
 * not a filtered/ordered list) — plus the two task_assign_privileges writes,
 * which need upsert-on-conflict(firm_id,user_id) the generic writer doesn't
 * have. Every other write (tasks/task_lists/task_subtasks/task_activity
 * insert/update/delete) goes through /api/data/:table instead — see
 * db/table-registry.ts. `select *` is safe here (no numeric columns needing
 * Number() coercion, unlike BOQ's rate/amount columns).
 */
@Injectable()
export class TasksService {
  constructor(private readonly db: DatabaseService) {}

  listTasks(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from tasks
          where firm_id = current_firm_id()
          order by order_index asc, created_at desc`,
      );
      return rows;
    });
  }

  listTaskLists(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from task_lists where firm_id = current_firm_id() order by order_index asc`,
      );
      return rows;
    });
  }

  /** Every subtask for the firm, unfiltered by task — matches the frontend
   * original, which fetches once and filters client-side per open task. */
  listSubtasks(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from task_subtasks where firm_id = current_firm_id() order by order_index asc`,
      );
      return rows;
    });
  }

  /** No explicit firm filter, same as the frontend original — RLS alone
   * scopes this to the caller's firm regardless of which task_id is asked
   * for, so a cross-firm task_id safely returns zero rows. */
  listActivity(authUid: string, taskId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from task_activity where task_id = $1 order by created_at desc`,
        [taskId],
      );
      return rows;
    });
  }

  listAssignPrivileges(authUid: string): Promise<string[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        `select user_id from task_assign_privileges where firm_id = current_firm_id()`,
      );
      return rows.map((r) => r.user_id);
    });
  }

  async grantAssignPrivilege(
    authUid: string,
    userId: string,
    userName: string,
    grantedBy: string,
  ): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into task_assign_privileges (firm_id, user_id, user_name, granted_by)
         values (current_firm_id(), $1, $2, $3)
         on conflict (firm_id, user_id) do update
           set user_name = excluded.user_name, granted_by = excluded.granted_by`,
        [userId, userName, grantedBy],
      ),
    );
  }

  async revokeAssignPrivilege(authUid: string, userId: string): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `delete from task_assign_privileges where firm_id = current_firm_id() and user_id = $1`,
        [userId],
      ),
    );
  }
}
