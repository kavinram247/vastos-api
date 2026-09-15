import { Body, Controller, Headers, HttpException, Post } from '@nestjs/common';
import { LeadsService } from './leads.service';

// No SupabaseAuthGuard here, deliberately — this is a customer's external
// website posting to a per-firm webhook token, with no session at all. The
// token (not the caller's identity or origin) is the entire trust boundary,
// exactly as it was as a Supabase Edge Function. See main.ts's OPEN_CORS_PREFIXES
// for the matching CORS carve-out.
const STATUS_FOR: Record<string, number> = {
  '28000': 401, // unknown or revoked token
  '42501': 403, // website capture disabled for this firm
  '22023': 400, // validation
  '54000': 429, // rate limit
};

interface IntakeBody {
  name?: unknown;
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  project_type?: unknown;
  project?: unknown;
  message?: unknown;
  requirements?: unknown;
}

@Controller('api/leads/intake')
export class LeadIntakePublicController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  async capture(
    @Headers('x-webhook-token') headerToken: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Body() body: IntakeBody,
  ) {
    const token =
      headerToken || (auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
    if (!token) {
      throw new HttpException({ ok: false, error: 'webhook token required' }, 401);
    }

    try {
      return await this.leads.captureIntake(token, {
        name: String(body.name ?? body.full_name ?? ''),
        email: body.email == null ? null : String(body.email),
        phone: body.phone == null ? null : String(body.phone),
        projectType:
          body.project_type == null && body.project == null
            ? null
            : String(body.project_type ?? body.project),
        message:
          body.message == null && body.requirements == null
            ? null
            : String(body.message ?? body.requirements),
      });
    } catch (err: any) {
      const code = err?.code as string | undefined;
      const status = STATUS_FOR[code ?? ''] ?? 500;
      if (status === 500) {
        // eslint-disable-next-line no-console
        console.error('[lead-intake]', code, err?.message);
      }
      throw new HttpException(
        { ok: false, error: status === 500 ? 'could not record enquiry' : err?.message },
        status,
      );
    }
  }
}
