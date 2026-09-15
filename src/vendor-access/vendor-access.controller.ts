import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { VendorAccessService } from './vendor-access.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/vendor-access')
@UseGuards(SupabaseAuthGuard)
export class VendorAccessController {
  constructor(private readonly access: VendorAccessService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.access.listViewers(req.user.id);
  }

  @Post()
  async grant(
    @Body() body: { userId: string; userName: string; grantedBy: string | null },
    @Req() req: AuthedRequest,
  ) {
    await this.access.grant(req.user.id, body.userId, body.userName, body.grantedBy);
    return { ok: true };
  }

  @Delete(':userId')
  async revoke(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    await this.access.revoke(req.user.id, userId);
    return { ok: true };
  }
}
