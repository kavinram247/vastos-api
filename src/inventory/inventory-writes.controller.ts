import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InventoryWritesService } from './inventory-writes.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/inventory')
@UseGuards(SupabaseAuthGuard)
export class InventoryWritesController {
  constructor(private readonly writes: InventoryWritesService) {}

  // ── Material requests ──────────────────────────────────────────────────
  @Post('material-requests')
  saveMaterialRequest(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveMaterialRequest(req.user.id, body.payload, body.items);
  }
  @Post('material-requests/:id/submit')
  submitMaterialRequest(@Param('id') id: string, @Body() body: { version: number }, @Req() req: AuthedRequest) {
    return this.writes.submitMaterialRequest(req.user.id, id, body.version);
  }
  @Post('material-requests/:id/decide')
  decideMaterialRequest(
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'reject'; notes: string | null; itemApprovals?: Record<string, number> },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.decideMaterialRequest(req.user.id, id, body.decision, body.notes, body.itemApprovals ?? {});
  }
  @Post('material-requests/:id/cancel')
  cancelMaterialRequest(@Param('id') id: string, @Body() body: { reason: string | null }, @Req() req: AuthedRequest) {
    return this.writes.cancelMaterialRequest(req.user.id, id, body.reason);
  }

  // ── Purchase orders ──────────────────────────────────────────────────
  @Post('purchase-orders')
  savePurchaseOrder(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.savePurchaseOrder(req.user.id, body.payload, body.items);
  }
  @Post('purchase-orders/:id/submit')
  submitPo(@Param('id') id: string, @Body() body: { version: number }, @Req() req: AuthedRequest) {
    return this.writes.submitPo(req.user.id, id, body.version);
  }
  @Post('purchase-orders/:id/decide')
  decidePo(
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'needs_changes' | 'reject'; notes: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.decidePo(req.user.id, id, body.decision, body.notes);
  }
  @Post('purchase-orders/:id/issue')
  issuePo(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.issuePo(req.user.id, id);
  }

  // ── Goods receipts ──────────────────────────────────────────────────
  @Post('goods-receipts')
  saveGoodsReceipt(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveGoodsReceipt(req.user.id, body.payload, body.items);
  }
  @Post('goods-receipts/:id/post')
  postGoodsReceipt(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.postGoodsReceipt(req.user.id, id);
  }

  // ── Consumption ──────────────────────────────────────────────────
  @Post('consumptions')
  saveConsumption(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveConsumption(req.user.id, body.payload, body.items);
  }
  @Post('consumptions/:id/post')
  postConsumption(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.postConsumption(req.user.id, id);
  }

  // ── Transfers ──────────────────────────────────────────────────
  @Post('transfers')
  saveTransfer(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveTransfer(req.user.id, body.payload, body.items);
  }
  @Post('transfers/:id/dispatch')
  dispatchTransfer(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.dispatchTransfer(req.user.id, id);
  }
  @Post('transfers/:id/receive')
  receiveTransfer(@Param('id') id: string, @Body() body: { received: Record<string, number> }, @Req() req: AuthedRequest) {
    return this.writes.receiveTransfer(req.user.id, id, body.received);
  }

  // ── Adjustments + counts ──────────────────────────────────────────────────
  @Post('adjustments')
  saveAdjustment(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveAdjustment(req.user.id, body.payload, body.items);
  }
  @Post('adjustments/:id/submit')
  submitAdjustment(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.submitAdjustment(req.user.id, id);
  }
  @Post('adjustments/:id/decide')
  decideAdjustment(
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'reject'; notes: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.decideAdjustment(req.user.id, id, body.decision, body.notes);
  }
  @Post('counts')
  saveCount(@Body() body: { payload: unknown; items: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveCount(req.user.id, body.payload, body.items);
  }
  @Post('counts/:id/post')
  postCount(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.postCount(req.user.id, id);
  }

  // ── RFQ ──────────────────────────────────────────────────
  @Post('rfqs')
  saveRfq(@Body() body: { payload: unknown; items: unknown[]; vendors: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.saveRfq(req.user.id, body.payload, body.items, body.vendors);
  }
  @Post('rfqs/:id/send')
  sendRfq(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.writes.sendRfq(req.user.id, id);
  }
  @Post('rfq-vendors/:id/quote')
  recordQuote(
    @Param('id') rfqVendorId: string,
    @Body() body: { terms: unknown; quoteItems: unknown[] },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.recordQuote(req.user.id, rfqVendorId, body.terms, body.quoteItems);
  }
  @Post('rfqs/:id/award')
  awardRfq(@Param('id') id: string, @Body() body: { awards: unknown[] }, @Req() req: AuthedRequest) {
    return this.writes.awardRfq(req.user.id, id, body.awards);
  }

  // ── Ledger corrections + policy + automation ──────────────────────────────────────────────────
  @Post('movements/:id/reverse')
  reverseMovement(@Param('id') movementId: string, @Body() body: { note: string | null }, @Req() req: AuthedRequest) {
    return this.writes.reverseMovement(req.user.id, movementId, body.note);
  }
  @Post('stock/reserve')
  reserveStock(
    @Body()
    body: {
      project: string; sku: string; qty: number; uom: string;
      refType: string; refId: string | null; note: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.reserveStock(
      req.user.id, body.project, body.sku, body.qty, body.uom, body.refType, body.refId, body.note,
    );
  }
  @Post('stock/release')
  releaseReservation(
    @Body()
    body: {
      project: string; sku: string; qty: number; uom: string;
      refType: string; refId: string | null; note: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.releaseReservation(
      req.user.id, body.project, body.sku, body.qty, body.uom, body.refType, body.refId, body.note,
    );
  }
  @Post('item-settings')
  saveItemSetting(
    @Body()
    body: {
      sku: string; project: string | null; reorder: number; safety: number;
      max: number | null; lead: number | null; vendor: string | null; notes: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.writes.saveItemSetting(
      req.user.id, body.sku, body.project, body.reorder, body.safety, body.max, body.lead, body.vendor, body.notes,
    );
  }
  @Post('alerts/refresh')
  refreshAlerts(@Req() req: AuthedRequest) {
    return this.writes.refreshAlerts(req.user.id);
  }
  @Post('outbox/process')
  processOutbox(@Body() body: { limit?: number }, @Req() req: AuthedRequest) {
    return this.writes.processOutbox(req.user.id, body.limit ?? 100);
  }
}
