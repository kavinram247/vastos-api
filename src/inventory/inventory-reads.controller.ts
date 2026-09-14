import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InventoryReadsService } from './inventory-reads.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/inventory')
@UseGuards(SupabaseAuthGuard)
export class InventoryReadsController {
  constructor(private readonly reads: InventoryReadsService) {}

  @Get('materials')
  materials(@Req() req: AuthedRequest) {
    return this.reads.listMaterials(req.user.id);
  }

  @Get('item-settings')
  itemSettings(@Req() req: AuthedRequest) {
    return this.reads.listItemSettings(req.user.id);
  }

  @Get('stock-positions')
  stockPositions(@Query('projectId') projectId: string | undefined, @Req() req: AuthedRequest) {
    return this.reads.listStockPositions(req.user.id, projectId);
  }

  @Get('movements')
  movements(
    @Query('projectId') projectId: string | undefined,
    @Query('skuId') skuId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.reads.listMovements(req.user.id, {
      projectId,
      skuId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('material-requests')
  materialRequests(@Req() req: AuthedRequest) {
    return this.reads.listMaterialRequests(req.user.id);
  }

  @Get('material-requests/:id/items')
  materialRequestItems(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reads.getMaterialRequestItems(req.user.id, id);
  }

  @Get('purchase-orders')
  purchaseOrders(@Req() req: AuthedRequest) {
    return this.reads.listPurchaseOrders(req.user.id);
  }

  @Get('purchase-orders/:id/items')
  poLineItems(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reads.getPoLineItems(req.user.id, id);
  }

  @Get('goods-receipts')
  goodsReceipts(@Req() req: AuthedRequest) {
    return this.reads.listGoodsReceipts(req.user.id);
  }

  @Get('goods-receipts/:id/items')
  goodsReceiptItems(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reads.getGoodsReceiptItems(req.user.id, id);
  }

  @Get('transfers')
  transfers(@Req() req: AuthedRequest) {
    return this.reads.listTransfers(req.user.id);
  }

  @Get('transfers/:id/items')
  transferItems(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reads.getTransferItems(req.user.id, id);
  }

  @Get('adjustments')
  adjustments(@Req() req: AuthedRequest) {
    return this.reads.listAdjustments(req.user.id);
  }

  @Get('counts')
  counts(@Req() req: AuthedRequest) {
    return this.reads.listCounts(req.user.id);
  }

  @Get('consumptions')
  consumptions(@Req() req: AuthedRequest) {
    return this.reads.listConsumptions(req.user.id);
  }

  @Get('rfqs')
  rfqs(@Req() req: AuthedRequest) {
    return this.reads.listRfqs(req.user.id);
  }

  @Get('rfqs/:id/detail')
  rfqDetail(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reads.getRfqDetail(req.user.id, id);
  }

  @Get('alerts')
  alerts(@Req() req: AuthedRequest) {
    return this.reads.listAlerts(req.user.id);
  }
}
