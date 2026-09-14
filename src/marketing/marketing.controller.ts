import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MarketingService } from './marketing.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/marketing')
@UseGuards(SupabaseAuthGuard)
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('data')
  data(@Req() req: AuthedRequest) {
    return this.marketing.fetchMarketingData(req.user.id);
  }

  @Post('sync-runs')
  async recordSyncRun(
    @Body() body: { accountId: string; rows: number; trigger?: 'manual' | 'mock' },
    @Req() req: AuthedRequest,
  ) {
    await this.marketing.recordSyncRun(req.user.id, body.accountId, body.rows, body.trigger ?? 'manual');
    return { ok: true };
  }
}
