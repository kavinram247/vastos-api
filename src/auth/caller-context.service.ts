import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface CallerContext {
  firmId: string;
  crmProfileId: string | null;
  isReadOnlyViewer: boolean;
  /** crm_roles.is_admin — implicit all-access. Mirrors the SQL helper
   *  current_is_firm_admin() that attendance_records' RLS uses. */
  isAdmin: boolean;
}

interface ProfileRow {
  id: string;
  firm_id: string;
  email: string;
}

interface CrmProfileRow {
  id: string;
  role_id: string | null;
}

interface RoleRow {
  scope: string;
  is_admin: boolean;
  enabled: boolean;
}

interface RolePermissionsRow {
  actions: string[];
}

// Replicates the frontend's identity/RBAC chain (AuthContext.resolveSession +
// usePermissions/can()) server-side, using withServiceRole because
// crm_roles/crm_role_permissions have no `authenticated` RLS policy at all —
// only a permissive anon-dev one a real user's token can't see through.
// Reads the VPS directly (not Supabase) so this resolves against the same
// profiles/crm_profiles/crm_roles rows every other already-migrated module
// writes to — this used to read Supabase's now-stale copy instead.
@Injectable()
export class CallerContextService {
  constructor(private readonly db: DatabaseService) {}

  async resolve(authUser: {
    id: string;
    email?: string;
  }): Promise<CallerContext | null> {
    return this.db.withServiceRole(async (client) => {
      const { rows: profileRows } = await client.query<ProfileRow>(
        `select id, firm_id, email from profiles where auth_uid = $1 limit 1`,
        [authUser.id],
      );
      const profile = profileRows[0] ?? null;
      if (!profile) return null;

      const { firm_id: firmId, email } = profile;

      const { rows: crmProfileRows } = await client.query<CrmProfileRow>(
        `select id, role_id from crm_profiles where email = $1 and firm_id = $2 limit 1`,
        [email, firmId],
      );
      const crmProfile = crmProfileRows[0] ?? null;

      const crmProfileId = crmProfile?.id ?? null;
      const roleId = crmProfile?.role_id ?? null;

      // No RBAC role assigned — can() always returns false in this case on the
      // frontend too, so treat as read-only regardless of anything else.
      if (!roleId) {
        return { firmId, crmProfileId, isReadOnlyViewer: true, isAdmin: false };
      }

      const { rows: roleRows } = await client.query<RoleRow>(
        `select scope, is_admin, enabled from crm_roles where id = $1 limit 1`,
        [roleId],
      );
      const role = roleRows[0] ?? null;

      if (!role || !role.enabled) {
        return { firmId, crmProfileId, isReadOnlyViewer: true, isAdmin: false };
      }
      if (role.is_admin) {
        return { firmId, crmProfileId, isReadOnlyViewer: false, isAdmin: true };
      }

      const { rows: permissionRows } = await client.query<RolePermissionsRow>(
        `select actions from crm_role_permissions where role_id = $1 and module = 'documents' limit 1`,
        [roleId],
      );
      const permissions = permissionRows[0] ?? null;

      const actions = permissions?.actions ?? [];
      const isReadOnlyViewer =
        role.scope === 'own' || !actions.includes('create');

      return { firmId, crmProfileId, isReadOnlyViewer, isAdmin: false };
    });
  }
}
