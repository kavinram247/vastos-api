import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * Inventory & Procurement reads (Vastos_ARC's src/inventory/inventoryApi.ts).
 * Every table here is SELECT-only under RLS — there is no INSERT/UPDATE/
 * DELETE policy for `authenticated` on any of them (confirmed via
 * pg_policies). All mutation goes through the inv_* SECURITY DEFINER RPCs
 * in inventory-writes.service.ts instead. Raw passthrough throughout, same
 * as the frontend original for most of these — numeric-string coercion
 * (num()) stays client-side in the rewritten inventoryApi.ts, matching the
 * file's existing convention rather than reshaping on the server.
 */
@Injectable()
export class InventoryReadsService {
  constructor(private readonly db: DatabaseService) {}

  /** Every active SKU with its canonical UOM + catalog meta, filtered to
   * this firm's own products plus shared global ones (mirrors the frontend
   * original's `!f || f === firmId` filter, done here via SQL instead of
   * post-fetch JS). */
  listMaterials(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select ps.id as sku_id, ps.sku_code, ps.brand, ps.quality_grade, ps.product_id,
                cp.name, cp.category_id, cp.base_uom, cp.secondary_uom, cp.uom_conversion,
                cp.gst_rate, cp.hsn_code, cat.name as category_name
           from product_skus ps
           join catalog_products cp on cp.id = ps.product_id
           left join catalog_categories cat on cat.id = cp.category_id
          where ps.is_active = true
            and (cp.firm_id is null or cp.firm_id = current_firm_id())
          order by cp.name`,
      );
      return rows;
    });
  }

  listItemSettings(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from inventory_item_settings where firm_id = current_firm_id()`,
      );
      return rows;
    });
  }

  /** Ledger-derived balances (on-hand / reserved / available / on-order / projected). */
  listStockPositions(authUid: string, projectId?: string) {
    return this.db.withCaller(authUid, async (client) => {
      const conditions = ['firm_id = current_firm_id()'];
      const values: unknown[] = [];
      if (projectId) {
        values.push(projectId);
        conditions.push(`project_id = $${values.length}`);
      }
      const { rows } = await client.query(
        `select * from stock_position where ${conditions.join(' and ')}`,
        values,
      );
      return rows;
    });
  }

  listMovements(authUid: string, opts: { projectId?: string; skuId?: string; limit?: number }) {
    return this.db.withCaller(authUid, async (client) => {
      const conditions = ['firm_id = current_firm_id()'];
      const values: unknown[] = [];
      if (opts.projectId) {
        values.push(opts.projectId);
        conditions.push(`project_id = $${values.length}`);
      }
      if (opts.skuId) {
        values.push(opts.skuId);
        conditions.push(`sku_id = $${values.length}`);
      }
      values.push(opts.limit ?? 300);
      const { rows } = await client.query(
        `select * from stock_movements where ${conditions.join(' and ')}
          order by created_at desc limit $${values.length}`,
        values,
      );
      return rows;
    });
  }

  listMaterialRequests(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from material_requests where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  getMaterialRequestItems(authUid: string, requestId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from material_request_items where request_id = $1 order by order_index`,
        [requestId],
      );
      return rows;
    });
  }

  listPurchaseOrders(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from purchase_orders where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  getPoLineItems(authUid: string, poId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from po_line_items where po_id = $1 order by created_at`,
        [poId],
      );
      return rows;
    });
  }

  listGoodsReceipts(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from goods_receipts where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  getGoodsReceiptItems(authUid: string, grnId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from goods_receipt_items where grn_id = $1 order by order_index`,
        [grnId],
      );
      return rows;
    });
  }

  listTransfers(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from stock_transfers where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  getTransferItems(authUid: string, transferId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from stock_transfer_items where transfer_id = $1 order by order_index`,
        [transferId],
      );
      return rows;
    });
  }

  listAdjustments(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from stock_adjustments where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  listCounts(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from physical_counts where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  listConsumptions(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from stock_consumptions where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  listRfqs(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from rfqs where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows;
    });
  }

  getRfqDetail(authUid: string, rfqId: string) {
    return this.db.withCaller(authUid, async (client) => {
      // Sequential, not Promise.all on one client — established lesson from
      // firm.service.ts/boq.service.ts (node-postgres queues per client).
      const items = await client.query(`select * from rfq_items where rfq_id = $1 order by order_index`, [rfqId]);
      const vendors = await client.query(`select * from rfq_vendors where rfq_id = $1 order by order_index`, [rfqId]);
      const quotes = await client.query(`select * from rfq_quote_items where rfq_id = $1`, [rfqId]);
      return { items: items.rows, vendors: vendors.rows, quotes: quotes.rows };
    });
  }

  listAlerts(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from inventory_alerts where firm_id = current_firm_id() and status = 'open' order by created_at desc`,
      );
      return rows;
    });
  }
}
