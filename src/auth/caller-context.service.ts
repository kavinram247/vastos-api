import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface CallerContext {
  firmId: string;
  crmProfileId: string | null;
  isReadOnlyViewer: boolean;
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
// usePermissions/can()) server-side, using the service-role client because
// crm_roles/crm_role_permissions have no `authenticated` RLS policy at all —
// only a permissive anon-dev one a real user's token can't see through.
@Injectable()
export class CallerContextService {
  constructor(private readonly supabase: SupabaseService) {}

  async resolve(authUser: {
    id: string;
    email?: string;
  }): Promise<CallerContext | null> {
    const db = this.supabase.getServiceRoleClient();

    const { data: profileData } = await db
      .from('profiles')
      .select('id,firm_id,email')
      .eq('auth_uid', authUser.id)
      .maybeSingle();
    const profile = profileData as ProfileRow | null;
    if (!profile) return null;

    const { firm_id: firmId, email } = profile;

    const { data: crmProfileData } = await db
      .from('crm_profiles')
      .select('id,role_id')
      .eq('email', email)
      .eq('firm_id', firmId)
      .maybeSingle();
    const crmProfile = crmProfileData as CrmProfileRow | null;

    const crmProfileId = crmProfile?.id ?? null;
    const roleId = crmProfile?.role_id ?? null;

    // No RBAC role assigned — can() always returns false in this case on the
    // frontend too, so treat as read-only regardless of anything else.
    if (!roleId) {
      return { firmId, crmProfileId, isReadOnlyViewer: true };
    }

    const { data: roleData } = await db
      .from('crm_roles')
      .select('scope,is_admin,enabled')
      .eq('id', roleId)
      .maybeSingle();
    const role = roleData as RoleRow | null;

    if (!role || !role.enabled) {
      return { firmId, crmProfileId, isReadOnlyViewer: true };
    }
    if (role.is_admin) {
      return { firmId, crmProfileId, isReadOnlyViewer: false };
    }

    const { data: permissionsData } = await db
      .from('crm_role_permissions')
      .select('actions')
      .eq('role_id', roleId)
      .eq('module', 'documents')
      .maybeSingle();
    const permissions = permissionsData as RolePermissionsRow | null;

    const actions = permissions?.actions ?? [];
    const isReadOnlyViewer =
      role.scope === 'own' || !actions.includes('create');

    return { firmId, crmProfileId, isReadOnlyViewer };
  }
}
