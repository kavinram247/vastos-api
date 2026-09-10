import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../db/database.service';

// ── row shapes as they come back from pg (index signature via QueryResultRow) ─
interface ProfileRow extends QueryResultRow {
  id: string;
  firm_id: string;
  email: string;
  full_name: string;
  role: string;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
}

interface FirmRow extends QueryResultRow {
  id: string;
  name: string;
  address: string | null;
  logo_url: string | null;
  gstin: string | null;
  payment_split_default: number;
  created_at: string;
  deleted_at: string | null;
}

interface PlanRow extends QueryResultRow {
  status: string;
  trial_ends_at: string | null;
  seats_purchased: number | null;
  plan_id: string | null;
  plan_name: string | null;
  module_keys: string[] | null;
  max_users: number | null;
  max_projects: number | null;
  storage_gb: number | null;
}

// ── the payload contract the SPA consumes (no pg index signature) ─────────────
export interface SessionProfile {
  id: string;
  firm_id: string;
  email: string;
  full_name: string;
  role: string;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  role_id: string | null;
}

export interface SessionFirm {
  id: string;
  name: string;
  address: string | null;
  logo_url: string | null;
  gstin: string | null;
  payment_split_default: number;
  created_at: string;
}

export interface SessionPlan {
  id: string;
  name: string | null;
  module_keys: string[];
  max_users: number | null;
  max_projects: number | null;
  storage_gb: number | null;
  status: string;
  trial_ends_at: string | null;
}

export interface BootstrapPayload {
  session: {
    profile: SessionProfile;
    firm: SessionFirm;
    plan: SessionPlan | null;
    isVastosOperator: boolean;
  };
  data: Record<string, unknown[]>;
}

// store-array name → table name. Mirrors src/lib/crmApi.ts TABLES in the
// frontend exactly, so `crmApi.hydrateAll()` can become a single fetch of
// this endpoint's `data` object with no reshaping.
const HYDRATION_TABLES: Record<string, string> = {
  profiles: 'crm_profiles',
  projects: 'crm_projects',
  assignments: 'crm_project_assignments',
  milestones: 'crm_milestones',
  siteUpdates: 'crm_site_updates',
  paymentPlans: 'crm_payment_plans',
  paymentSplits: 'crm_payment_splits',
  paymentsReceived: 'crm_payments_received',
  costEntries: 'crm_cost_entries',
  comments: 'crm_comments',
  notifications: 'crm_notifications',
  activityLog: 'crm_activity_log',
  leads: 'crm_leads',
  leadInteractions: 'crm_lead_interactions',
  leadQuotations: 'crm_lead_quotations',
  projectDocuments: 'crm_project_documents',
  projectVendors: 'crm_project_vendors',
  contacts: 'crm_contacts',
  pipelineStages: 'crm_pipeline_stages',
  featureFlags: 'crm_feature_flags',
  commChannels: 'crm_comm_channels',
  roles: 'crm_roles',
  rolePermissions: 'crm_role_permissions',
  dashboardLayouts: 'crm_dashboard_layouts',
};

// Both sides of the map are compile-time constants, never user input, but
// assert their shape before interpolating so this stays safe if the map grows.
const TABLE_IDENT = /^[a-z_][a-z0-9_]*$/; // table name → unquoted SQL identifier
const KEY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/; // store key → quoted column alias

@Injectable()
export class FirmService {
  constructor(private readonly db: DatabaseService) {}

  async bootstrap(authUid: string): Promise<BootstrapPayload> {
    // One pooled connection, one transaction: every read below sees the same
    // snapshot and the same `request.jwt.claims`. node-postgres runs one query
    // at a time per client, so these are sequential by nature — not a
    // parallelism regression, and `hydrate()` is a single round trip.
    return this.db.withCaller(authUid, async (client) => {
      const profile = await this.resolveProfile(client, authUid);
      const firm = await this.resolveFirm(client);
      const plan = await this.resolvePlan(client, firm.id);
      const isVastosOperator = await this.resolveOperator(client);
      const data = await this.hydrate(client);

      // role_id lives on crm_profiles (matched by email + firm_id — profiles.id
      // and crm_profiles.id are separate UUID spaces), same as the frontend's
      // resolveSession.
      const crmProfiles = (data.profiles ?? []) as Array<{
        email?: string;
        firm_id?: string;
        role_id?: string | null;
      }>;
      const crmProfile = crmProfiles.find(
        (r) =>
          (r.email ?? '').toLowerCase() === profile.email.toLowerCase() &&
          r.firm_id === firm.id,
      );
      profile.role_id = crmProfile?.role_id ?? null;

      return { session: { profile, firm, plan, isVastosOperator }, data };
    });
  }

  private async resolveProfile(
    client: PoolClient,
    authUid: string,
  ): Promise<SessionProfile> {
    const { rows } = await client.query<ProfileRow>(
      `select id, firm_id, email, full_name, role, phone, avatar_url, created_at
         from profiles
        where auth_uid = $1
        limit 1`,
      [authUid],
    );
    const row = rows[0];
    if (!row) throw new ForbiddenException('No profile for this account');
    return {
      id: row.id,
      firm_id: row.firm_id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      phone: row.phone,
      avatar_url: row.avatar_url,
      created_at: row.created_at,
      role_id: null, // filled in bootstrap() from crm_profiles
    };
  }

  private async resolveFirm(client: PoolClient): Promise<SessionFirm> {
    // RLS scopes `firms` to `id = current_firm_id()`, so the caller's own firm
    // is the only visible row.
    const { rows } = await client.query<FirmRow>(
      `select id, name, address, logo_url, gstin, payment_split_default,
              created_at, deleted_at
         from firms
        where id = current_firm_id()
        limit 1`,
    );
    const row = rows[0];
    if (!row) throw new ForbiddenException('Firm not found');
    if (row.deleted_at) throw new ForbiddenException('Firm has been closed');
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      logo_url: row.logo_url,
      gstin: row.gstin,
      payment_split_default: row.payment_split_default,
      created_at: row.created_at,
    };
  }

  private async resolvePlan(
    client: PoolClient,
    firmId: string,
  ): Promise<SessionPlan | null> {
    const { rows } = await client.query<PlanRow>(
      `select fs.status, fs.trial_ends_at, fs.seats_purchased,
              sp.id   as plan_id,
              sp.name as plan_name,
              sp.module_keys, sp.max_users, sp.max_projects, sp.storage_gb
         from firm_subscriptions fs
         left join subscription_plans sp on sp.id = fs.plan_id
        where fs.firm_id = $1
        limit 1`,
      [firmId],
    );
    const row = rows[0];
    if (!row || !row.plan_id) return null;
    return {
      id: row.plan_id,
      name: row.plan_name,
      module_keys: row.module_keys ?? [],
      // a custom seat override wins over the plan default
      max_users: row.seats_purchased ?? row.max_users,
      max_projects: row.max_projects,
      storage_gb: row.storage_gb,
      status: row.status,
      trial_ends_at: row.trial_ends_at,
    };
  }

  private async resolveOperator(client: PoolClient): Promise<boolean> {
    // Deny-all allowlist resolved server-side from auth.uid(); fail closed if
    // the function is somehow absent on an older schema.
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        'select is_vastos_operator() as ok',
      );
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }

  private async hydrate(
    client: PoolClient,
  ): Promise<Record<string, unknown[]>> {
    const keys = Object.keys(HYDRATION_TABLES);

    // One query, one column per store array, each a json_agg of that table's
    // firm-visible rows. RLS applies inside every sub-select. `[]` for empty.
    const columns = keys
      .map((k) => {
        const table = HYDRATION_TABLES[k];
        if (!TABLE_IDENT.test(table) || !KEY_IDENT.test(k)) {
          throw new Error(`refusing to build hydration column for "${k}"`);
        }
        return `(select coalesce(json_agg(row_to_json(_t)), '[]'::json)
                   from ${table} _t) as "${k}"`;
      })
      .join(',\n');

    const { rows } = await client.query<Record<string, unknown[]>>(
      `select ${columns}`,
    );
    const row = rows[0] ?? {};

    const out: Record<string, unknown[]> = {};
    for (const k of keys) out[k] = row[k] ?? [];
    return out;
  }
}
