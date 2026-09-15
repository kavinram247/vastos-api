import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PurchaseStockService } from './purchase-stock.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/purchase')
@UseGuards(SupabaseAuthGuard)
export class PurchaseStockController {
  constructor(private readonly stock: PurchaseStockService) {}

  @Get('stock')
  listStock(@Req() req: AuthedRequest) {
    return this.stock.listStock(req.user.id);
  }

  @Get('work-orders')
  listWorkOrders(@Req() req: AuthedRequest) {
    return this.stock.listWorkOrders(req.user.id);
  }

  @Post('work-orders')
  saveWorkOrder(@Body() body: any, @Req() req: AuthedRequest) {
    return this.stock.saveWorkOrder(req.user.id, body, body.userId);
  }

  @Delete('work-orders/:id')
  deleteWorkOrder(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.stock.deleteWorkOrder(req.user.id, id);
  }
}
