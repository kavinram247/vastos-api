import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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

  @Get('intake-tokens')
  async listIntakeTokens(@Req() req: AuthedRequest) {
    return this.leads.listIntakeTokens(req.user.id);
  }

  @Post('intake-tokens')
  async createIntakeToken(
    @Body() body: { label?: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.leads.createIntakeToken(req.user.id, body.label ?? null);
  }

  @Delete('intake-tokens/:id')
  async revokeIntakeToken(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    await this.leads.revokeIntakeToken(req.user.id, id);
    return { ok: true };
  }
}
