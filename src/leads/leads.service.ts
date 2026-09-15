import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface LeadRow {
  id: string;
  assigned_to: string | null;
  [key: string]: unknown;
}

export interface WebhookToken {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface FreshWebhookToken {
  id: string;
  token: string;
  firm_id: string;
}

export interface IntakeFields {
  name: string;
  email: string | null;
  phone: string | null;
  projectType: string | null;
  message: string | null;
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

  /**
   * Website enquiry-capture webhook tokens (LeadsAdminPage.tsx's
   * WebhookTokens component). All three are thin proxies to SECURITY
   * DEFINER RPCs on crm_webhook_tokens — RLS on that table has zero
   * policies (confirmed via pg_policies), so there is no direct-table
   * path even if the generic /api/data layer were extended to cover it.
   * The raw token itself is only ever returned by create — the table
   * stores a hash and there is no read path back to it.
   */
  listIntakeTokens(authUid: string): Promise<WebhookToken[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<WebhookToken>(
        `select * from list_lead_intake_tokens()`,
      );
      return rows;
    });
  }

  createIntakeToken(
    authUid: string,
    label: string | null,
  ): Promise<FreshWebhookToken> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: FreshWebhookToken }>(
        `select create_lead_intake_token($1) as result`,
        [label],
      );
      return rows[0].result;
    });
  }

  revokeIntakeToken(authUid: string, id: string): Promise<void> {
    return this.db.withCaller(authUid, async (client) => {
      await client.query(`select revoke_lead_intake_token($1)`, [id]);
    });
  }

  /**
   * The actual website-enquiry capture (formerly the `lead-intake` Supabase
   * Edge Function calling `lead_intake_capture` against Supabase's own
   * Postgres). No session exists — the caller is an external website's
   * contact form — so this runs via withServiceRole and leans entirely on
   * the RPC's own token-based authorization (crm_webhook_tokens lookup),
   * exactly as SECURITY DEFINER + the `anon`-equivalent role did under
   * PostgREST. Errors carry the RPC's own SQLSTATE on err.code, same set
   * the edge function mapped (28000/42501/22023/54000).
   */
  captureIntake(
    token: string,
    fields: IntakeFields,
  ): Promise<{ ok: true; lead_id: string }> {
    return this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: { ok: true; lead_id: string } }>(
        `select lead_intake_capture($1, $2, $3, $4, $5, $6) as result`,
        [token, fields.name, fields.email, fields.phone, fields.projectType, fields.message],
      );
      return rows[0].result;
    });
  }
}
