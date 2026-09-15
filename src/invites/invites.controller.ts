import { Body, Controller, HttpException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InvitesService } from './invites.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

interface CreateInviteBody {
  email: string;
  fullName: string;
  roleId?: string | null;
  phone?: string | null;
}

// create_invite's own SQLSTATEs -- distinct business errors, not generic
// Postgres failures, so the caller's real message is worth keeping.
const STATUS_FOR: Record<string, number> = {
  '28000': 401, // not authenticated
  '42501': 403, // only an administrator may invite users
  '22023': 400, // validation (email shape, unknown role for this firm)
  '23505': 409, // already a member
};

@Controller('api/team/invites')
@UseGuards(SupabaseAuthGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  async create(@Body() body: CreateInviteBody, @Req() req: AuthedRequest) {
    try {
      return await this.invites.createInvite(
        req.user.id,
        body.email,
        body.fullName,
        body.roleId ?? null,
        body.phone ?? null,
      );
    } catch (err: any) {
      const status = STATUS_FOR[err?.code as string] ?? 500;
      if (status === 500) {
        // eslint-disable-next-line no-console
        console.error('[invites.create]', err?.code, err?.message);
      }
      throw new HttpException(status === 500 ? 'Failed to create invite' : err.message, status);
    }
  }
}
