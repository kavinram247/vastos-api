import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LeadsService } from './leads.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/leads')
@UseGuards(SupabaseAuthGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Post(':id/claim')
  async claim(
    @Param('id') id: string,
    @Body() body: { userId: string },
    @Req() req: AuthedRequest,
  ) {
    const row = await this.leads.claim(req.user.id, id, body.userId);
    return row ? { ok: true, lead: row } : { ok: false, reason: 'taken' };
  }
}
