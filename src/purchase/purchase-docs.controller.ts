import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PurchaseDocsService } from './purchase-docs.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/purchase')
@UseGuards(SupabaseAuthGuard)
export class PurchaseDocsController {
  constructor(private readonly docs: PurchaseDocsService) {}

  @Get('requests')
  listRequests(@Req() req: AuthedRequest) {
    return this.docs.listRequests(req.user.id);
  }

  @Post('requests')
  saveRequest(@Body() body: any, @Req() req: AuthedRequest) {
    return this.docs.saveRequest(req.user.id, body, body.userId);
  }

  @Delete('requests/:id')
  deleteRequest(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.docs.deleteRequest(req.user.id, id);
  }

  @Post('requests/:id/to-rfq')
  createRfqFromRequest(@Param('id') id: string, @Body() body: { userId: string }, @Req() req: AuthedRequest) {
    return this.docs.createRfqFromRequest(req.user.id, id, body.userId);
  }

  @Get('rfqs')
  listRfqs(@Req() req: AuthedRequest) {
    return this.docs.listRfqs(req.user.id);
  }

  @Post('rfqs')
  saveRfq(@Body() body: any, @Req() req: AuthedRequest) {
    return this.docs.saveRfq(req.user.id, body, body.userId);
  }

  @Delete('rfqs/:id')
  deleteRfq(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.docs.deleteRfq(req.user.id, id);
  }
}
