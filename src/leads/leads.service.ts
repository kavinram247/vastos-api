import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface LeadRow {
  id: string;
  assigned_to: string | null;
  [key: string]: unknown;
}

@Injectable()
export class LeadsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Atomically claim an unassigned lead — mirrors crmApi.ts's claimLeadRow.
   * The `and assigned_to is null` guard means Postgres evaluates the whole
   * predicate atomically: if two agents race, exactly one UPDATE matches.
   * Returns the winning row, or null if it was already taken.
   */
  async claim(
    authUid: string,
    leadId: string,
    userId: string,
  ): Promise<LeadRow | null> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<LeadRow>(
        `update crm_leads
            set assigned_to = $1, updated_at = now()
          where id = $2
            and assigned_to is null
          returning *`,
        [userId, leadId],
      );
      return rows[0] ?? null;
    });
  }
}
