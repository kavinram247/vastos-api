import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PurchaseOrdersService } from './purchase-orders.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/purchase/orders')
@UseGuards(SupabaseAuthGuard)
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.orders.listPurchaseOrders(req.user.id);
  }

  @Post()
  save(@Body() body: any, @Req() req: AuthedRequest) {
    return this.orders.savePurchaseOrder(req.user.id, body);
  }

  @Post(':id/submit')
  submit(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.submitForApproval(req.user.id, id);
  }

  @Post(':id/decide')
  decide(
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected'; notes: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.orders.decidePoApproval(req.user.id, id, body.decision, body.notes);
  }

  @Post(':id/payments')
  addPayment(
    @Param('id') id: string,
    @Body() body: { payment_date: string; amount: number; payment_mode: string | null; reference_no: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.orders.addPayment(req.user.id, id, body);
  }

  @Post(':id/receive')
  receive(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.receivePurchaseOrder(req.user.id, id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.deletePurchaseOrder(req.user.id, id);
  }

  @Post('from-rfq/:rfqId')
  fromRfq(@Param('rfqId') rfqId: string, @Body() body: { userId: string }, @Req() req: AuthedRequest) {
    return this.orders.createPoFromRfq(req.user.id, rfqId, body.userId);
  }

  @Post('from-request/:requestId')
  fromRequest(@Param('requestId') requestId: string, @Body() body: { userId: string }, @Req() req: AuthedRequest) {
    return this.orders.createPoFromRequest(req.user.id, requestId, body.userId);
  }
}
