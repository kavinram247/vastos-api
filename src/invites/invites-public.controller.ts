import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InvitesService } from './invites.service';

interface AcceptBody {
  password?: string;
}

// No SupabaseAuthGuard -- by definition, an invitee has no session yet.
// Served from Vastos_ARC's own SPA (AcceptInvitePage.tsx), so no CORS
// carve-out is needed. validate_invite never raises (always a status
// field); acceptInvite's own errors already carry the right HTTP status.
@Controller('api/invites')
export class InvitesPublicController {
  constructor(private readonly invites: InvitesService) {}

  @Get(':token')
  validate(@Param('token') token: string) {
    return this.invites.validateInvite(token);
  }

  @Post(':token/accept')
  accept(@Param('token') token: string, @Body() body: AcceptBody) {
    return this.invites.acceptInvite(token, body.password ?? '');
  }
}
