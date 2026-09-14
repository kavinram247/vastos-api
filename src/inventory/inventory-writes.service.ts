import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * Inventory & Procurement writes (Vastos_ARC's src/inventory/inventoryApi.ts).
 * Every one of these is a thin proxy to a SECURITY DEFINER inv_* RPC that
 * already resolves firm/actor/role from the session and validates every
 * transition server-side — exactly what supabase-js's `.rpc()` did before.
 * This file adds no business logic of its own, same as the frontend
 * original's own stated design ("this file therefore contains NO stock math
 * and NO status transitions — those live in Postgres").
 */
@Injectable()
export class InventoryWritesService {
  constructor(private readonly db: DatabaseService) {}

  private rpc<T>(authUid: string, sql: string, params: unknown[]): Promise<T> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: T }>(sql, params);
      return rows[0]?.result as T;
    });
  }

  // ── Material requests ──────────────────────────────────────────────────
  saveMaterialRequest(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_material_request($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  submitMaterialRequest(authUid: string, id: string, version: number) {
    return this.rpc<null>(authUid, `select inv_submit_material_request($1, $2) as result`, [id, version]);
  }
  decideMaterialRequest(
    authUid: string,
    id: string,
    decision: 'approve' | 'reject',
    notes: string | null,
    itemApprovals: Record<string, number>,
  ) {
    return this.rpc<null>(
      authUid,
      `select inv_decide_material_request($1, $2, $3, $4::jsonb) as result`,
      [id, decision, notes, JSON.stringify(itemApprovals)],
    );
  }
  cancelMaterialRequest(authUid: string, id: string, reason: string | null) {
    return this.rpc<null>(authUid, `select inv_cancel_material_request($1, $2) as result`, [id, reason]);
  }

  // ── Purchase orders ──────────────────────────────────────────────────
  savePurchaseOrder(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_purchase_order($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  submitPo(authUid: string, id: string, version: number) {
    return this.rpc<null>(authUid, `select inv_submit_po($1, $2) as result`, [id, version]);
  }
  decidePo(authUid: string, id: string, decision: 'approve' | 'needs_changes' | 'reject', notes: string | null) {
    return this.rpc<null>(authUid, `select inv_decide_po($1, $2, $3) as result`, [id, decision, notes]);
  }
  issuePo(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_issue_po($1) as result`, [id]);
  }

  // ── Goods receipts ──────────────────────────────────────────────────
  saveGoodsReceipt(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_goods_receipt($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  postGoodsReceipt(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_post_goods_receipt($1) as result`, [id]);
  }

  // ── Consumption ──────────────────────────────────────────────────
  saveConsumption(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_consumption($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  postConsumption(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_post_consumption($1) as result`, [id]);
  }

  // ── Transfers ──────────────────────────────────────────────────
  saveTransfer(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_transfer($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  dispatchTransfer(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_dispatch_transfer($1) as result`, [id]);
  }
  receiveTransfer(authUid: string, id: string, received: Record<string, number>) {
    return this.rpc<null>(authUid, `select inv_receive_transfer($1, $2::jsonb) as result`, [
      id,
      JSON.stringify(received),
    ]);
  }

  // ── Adjustments + counts ──────────────────────────────────────────────────
  saveAdjustment(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_adjustment($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  submitAdjustment(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_submit_adjustment($1) as result`, [id]);
  }
  decideAdjustment(authUid: string, id: string, decision: 'approve' | 'reject', notes: string | null) {
    return this.rpc<null>(authUid, `select inv_decide_adjustment($1, $2, $3) as result`, [id, decision, notes]);
  }
  saveCount(authUid: string, payload: unknown, items: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_count($1::jsonb, $2::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
    ]);
  }
  postCount(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_post_count($1) as result`, [id]);
  }

  // ── RFQ ──────────────────────────────────────────────────
  saveRfq(authUid: string, payload: unknown, items: unknown[], vendors: unknown[]) {
    return this.rpc<string>(authUid, `select inv_save_rfq($1::jsonb, $2::jsonb, $3::jsonb) as result`, [
      JSON.stringify(payload),
      JSON.stringify(items),
      JSON.stringify(vendors),
    ]);
  }
  sendRfq(authUid: string, id: string) {
    return this.rpc<null>(authUid, `select inv_send_rfq($1) as result`, [id]);
  }
  recordQuote(authUid: string, rfqVendorId: string, terms: unknown, quoteItems: unknown[]) {
    return this.rpc<null>(authUid, `select inv_record_quote($1, $2::jsonb, $3::jsonb) as result`, [
      rfqVendorId,
      JSON.stringify(terms),
      JSON.stringify(quoteItems),
    ]);
  }
  awardRfq(authUid: string, id: string, awards: unknown[]) {
    return this.rpc<null>(authUid, `select inv_award_rfq($1, $2::jsonb) as result`, [id, JSON.stringify(awards)]);
  }

  // ── Ledger corrections + policy + automation ──────────────────────────────────────────────────
  reverseMovement(authUid: string, movementId: string, note: string | null) {
    return this.rpc<string>(authUid, `select inv_reverse_movement($1, $2) as result`, [movementId, note]);
  }
  reserveStock(
    authUid: string,
    project: string,
    sku: string,
    qty: number,
    uom: string,
    refType: string,
    refId: string | null,
    note: string | null,
  ) {
    return this.rpc<string>(
      authUid,
      `select inv_reserve_stock($1, $2, $3, $4::uom, $5, $6, $7) as result`,
      [project, sku, qty, uom, refType, refId, note],
    );
  }
  releaseReservation(
    authUid: string,
    project: string,
    sku: string,
    qty: number,
    uom: string,
    refType: string,
    refId: string | null,
    note: string | null,
  ) {
    return this.rpc<string>(
      authUid,
      `select inv_release_reservation($1, $2, $3, $4::uom, $5, $6, $7) as result`,
      [project, sku, qty, uom, refType, refId, note],
    );
  }
  saveItemSetting(
    authUid: string,
    sku: string,
    project: string | null,
    reorder: number,
    safety: number,
    max: number | null,
    lead: number | null,
    vendor: string | null,
    notes: string | null,
  ) {
    return this.rpc<string>(
      authUid,
      `select inv_save_item_setting($1, $2, $3, $4, $5, $6, $7, $8) as result`,
      [sku, project, reorder, safety, max, lead, vendor, notes],
    );
  }
  refreshAlerts(authUid: string) {
    return this.rpc<number>(authUid, `select inv_refresh_alerts() as result`, []);
  }
  processOutbox(authUid: string, limit: number) {
    return this.rpc<number>(authUid, `select inv_process_outbox($1) as result`, [limit]);
  }
}
