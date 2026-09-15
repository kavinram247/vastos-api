import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { SupabaseService } from '../supabase/supabase.service';

export interface CreatedInvite {
  id: string;
  email: string;
  token: string;
  expires_at: string;
}

interface ClaimResult {
  status: 'claimed' | 'used' | 'expired' | 'invalid';
  invite_id?: string;
  firm_id?: string;
  email?: string;
  full_name?: string | null;
  role_id?: string | null;
}

// Fixed codes only, matching what AcceptInvitePage.tsx already maps to copy
// (ERROR_COPY) -- ported verbatim from the accept-invite Edge Function so the
// frontend needs no changes beyond where it calls.
type AcceptErrorCode =
  | 'invalid'
  | 'already_used'
  | 'expired'
  | 'bad_request'
  | 'weak_password'
  | 'email_registered'
  | 'server_error';

const ACCEPT_STATUS_FOR: Record<AcceptErrorCode, number> = {
  invalid: 400,
  bad_request: 400,
  weak_password: 400,
  already_used: 409,
  email_registered: 409,
  expired: 410,
  server_error: 500,
};

function acceptError(code: AcceptErrorCode, extra?: Record<string, unknown>): HttpException {
  return new HttpException({ error: code, ...extra }, ACCEPT_STATUS_FOR[code]);
}

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

// Server-side password policy -- the one that actually counts. Ported
// verbatim from accept-invite/index.ts; AcceptInvitePage.tsx enforces the
// same minimum client-side only for immediate feedback.
function passwordRejected(password: string, email: string): string | null {
  if (typeof password !== 'string') return 'not a string';
  if (password.length < MIN_PASSWORD) return `shorter than ${MIN_PASSWORD}`;
  if (password.length > MAX_PASSWORD) return `longer than ${MAX_PASSWORD}`;
  if (/^(.)\1+$/.test(password)) return 'a single repeated character';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const lower = password.toLowerCase();
  if (local.length >= 3 && lower.includes(local)) return 'contains the email name';
  if (['password', 'qwerty', '1234567890', 'letmein'].some((w) => lower.includes(w))) {
    return 'contains a common word';
  }
  return null;
}

/**
 * Team invites (UserManagementPage.tsx create_invite RPC + AcceptInvitePage.tsx
 * validate_invite/accept-invite Edge Function). Auth itself stays on Supabase
 * by design (Phase 5's whole premise) -- this is the one place that boundary
 * is crossed for real: creating the actual auth.users row is the one step
 * that genuinely cannot move, everything else (token validation, profile
 * creation, firm binding) now runs against the VPS via the same SECURITY
 * DEFINER RPCs schema-replayed there since item 1.
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly supabase: SupabaseService,
  ) {}

  /** Authenticated: an admin inviting a new teammate. */
  createInvite(
    authUid: string,
    email: string,
    fullName: string,
    roleId: string | null,
    phone: string | null,
  ): Promise<CreatedInvite> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: CreatedInvite }>(
        `select create_invite($1, $2, $3, $4) as result`,
        [email, fullName, roleId, phone],
      );
      return rows[0].result;
    });
  }

  /** Public: the invitee opening their link. Never raises -- always a status. */
  validateInvite(token: string): Promise<unknown> {
    return this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: unknown }>(
        `select validate_invite($1) as result`,
        [token],
      );
      return rows[0].result;
    });
  }

  /**
   * Public: the invitee setting a password. Mirrors accept-invite/index.ts's
   * claim -> createUser -> finalize sequence exactly, including its
   * compensation on partial failure -- just split across two databases
   * instead of one Postgres transaction (invite_finalize takes the new
   * auth_uid as an explicit parameter for exactly this reason).
   */
  async acceptInvite(token: string, password: string): Promise<{ success: true }> {
    const claim = await this.claimInvite(token);
    if (claim.status !== 'claimed') {
      if (claim.status === 'used') throw acceptError('already_used');
      if (claim.status === 'expired') throw acceptError('expired');
      throw acceptError('invalid');
    }

    let inviteId: string | null = claim.invite_id!;
    const email = claim.email!;

    try {
      const why = passwordRejected(password, email);
      if (why) {
        await this.releaseInvite(inviteId);
        inviteId = null;
        throw acceptError('weak_password', { min: MIN_PASSWORD });
      }

      const admin = this.supabase.getServiceRoleClient().auth.admin;
      const { data: userData, error: ue } = await admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: claim.full_name ?? email.split('@')[0], firm_id: claim.firm_id },
      });
      let authUid: string | null = userData?.user?.id ?? null;

      if (ue) {
        const orphan = await this.adoptableOrphan(email);
        if (!orphan) {
          this.logger.error(`createUser failed: ${ue.message}`);
          throw acceptError('email_registered');
        }
        const { error: pe } = await admin.updateUserById(orphan, { password, email_confirm: true });
        if (pe) {
          this.logger.error(`adopting orphaned auth user failed: ${pe.message}`);
          throw acceptError('email_registered');
        }
        authUid = orphan;
        this.logger.log(`adopted orphaned auth user for ${email}`);
      }

      if (!authUid) {
        this.logger.error('no auth uid after createUser');
        throw acceptError('server_error');
      }

      try {
        await this.db.withServiceRole(async (client) => {
          await client.query(`select invite_finalize($1, $2)`, [inviteId, authUid]);
        });
      } catch (fe: any) {
        this.logger.error(`invite_finalize failed, rolling back: ${fe.message}`);
        if (!ue) {
          await admin.deleteUser(authUid).catch((de) => this.logger.error(`could not delete auth user after rollback: ${de.message}`));
        }
        throw acceptError('server_error');
      }

      inviteId = null;
      return { success: true };
    } finally {
      if (inviteId) await this.releaseInvite(inviteId).catch(() => undefined);
    }
  }

  private claimInvite(token: string): Promise<ClaimResult> {
    return this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: ClaimResult }>(
        `select invite_claim($1) as result`,
        [token],
      );
      return rows[0].result;
    });
  }

  private releaseInvite(inviteId: string): Promise<void> {
    return this.db.withServiceRole(async (client) => {
      await client.query(`select invite_release($1)`, [inviteId]);
    });
  }

  /** Returns the auth uid for `email` only when no profile is linked to it yet
   * on the VPS -- the signature of a redemption that died half-way. */
  private async adoptableOrphan(email: string): Promise<string | null> {
    const admin = this.supabase.getServiceRoleClient().auth.admin;
    const { data, error } = await admin.listUsers({ page: 1, perPage: 200 });
    if (error) {
      this.logger.error(`listUsers failed: ${error.message}`);
      return null;
    }
    const want = email.toLowerCase();
    const user = data.users.find((u) => (u.email ?? '').toLowerCase() === want);
    if (!user) return null;

    const linked = await this.db.withServiceRole(async (client) => {
      const { rows } = await client.query(`select 1 from profiles where auth_uid = $1 limit 1`, [user.id]);
      return rows.length > 0;
    });
    return linked ? null : user.id;
  }
}
