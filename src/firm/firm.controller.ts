import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { FirmService, type BootstrapPayload } from './firm.service';

@Controller('api/firm')
@UseGuards(SupabaseAuthGuard)
export class FirmController {
  constructor(private readonly firm: FirmService) {}

  /**
   * One round trip for everything the SPA needs at login: the resolved session
   * (profile, firm, plan, operator flag) plus every crm_* table for the firm,
   * already keyed by the frontend store's array names. Replaces
   * AuthContext.resolveSession + crmApi.hydrateAll.
   */
  @Get('bootstrap')
  async bootstrap(
    @Req() req: Request & { user: { id: string; email?: string } },
  ): Promise<BootstrapPayload> {
    return this.firm.bootstrap(req.user.id);
  }
}
