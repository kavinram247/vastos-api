import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * Vendor visibility allow-list (Vastos_ARC's src/lib/vendorAccessApi.ts):
 * which non-owner staff may see a project's "Vendors & Contractors" section.
 * Firm-wide, keyed by the legacy crm_profiles id as text. Granting is an
 * upsert on (firm_id, user_id), which the generic /api/data layer has no
 * primitive for — the same shape as tasks' assign-privilege endpoints.
 */
@Injectable()
export class VendorAccessService {
  constructor(private readonly db: DatabaseService) {}

  listViewers(authUid: string): Promise<string[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        `select user_id from vendor_visibility_grants where firm_id = current_firm_id()`,
      );
      return rows.map((r) => r.user_id);
    });
  }

  async grant(
    authUid: string,
    userId: string,
    userName: string,
    grantedBy: string | null,
  ): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into vendor_visibility_grants (firm_id, user_id, user_name, granted_by)
         values (current_firm_id(), $1, $2, $3)
         on conflict (firm_id, user_id) do update
           set user_name = excluded.user_name, granted_by = excluded.granted_by`,
        [userId, userName, grantedBy],
      ),
    );
  }

  async revoke(authUid: string, userId: string): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `delete from vendor_visibility_grants where firm_id = current_firm_id() and user_id = $1`,
        [userId],
      ),
    );
  }
}
