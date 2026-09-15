import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import { formatDocNumber } from './purchase-logic';

/**
 * Material Requests (the CMR intake) + RFQs — net-new procurement entities,
 * not shared with any other module (unlike vendors/catalog_products/
 * purchase_orders/po_line_items). Header + child rows are written together,
 * children replaced on save, same as Vastos_ARC's src/purchase/docsApi.ts —
 * but as one `withCaller` transaction instead of 2-3 separate supabase-js
 * round trips, so a save can no longer land header changes with stale items
 * if a later statement fails.
 *
 * Reads project every field explicitly, with Number() on the numeric columns
 * (quantity, unit_price, quoted_amount), exactly like the original mapping:
 * node-postgres returns `numeric` as a string, so a bare `select *` would
 * hand the frontend "5" where every interface expects 5.
 *
 * Queries inside one transaction are awaited one at a time, never
 * Promise.all'd: a transaction is a single connection, so there's no
 * concurrency to gain, and concurrent client.query() on one pg client is
 * deprecated in pg 8 (removed in pg 9).
 *
 * setRequestStatus/setRfqStatus are called by PurchaseOrdersService (PO
 * conversion flows) as well as by this service's own createRfqFromRequest —
 * exported here, not routed through any HTTP endpoint of their own, mirroring
 * the frontend original where these are internal helpers, never called
 * directly from a page.
 */
@Injectable()
export class PurchaseDocsService {
  constructor(private readonly db: DatabaseService) {}

  private async nextSeq(client: PoolClient, table: string): Promise<number> {
    const { rows } = await client.query(
      `select count(*)::int as n from ${table} where firm_id = current_firm_id()`,
    );
    return (rows[0]?.n ?? 0) + 1;
  }

  // ═══ MATERIAL REQUESTS ═══════════════════════════════════════
  listRequests(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const reqs = await client.query(
        `select * from purchase_material_requests where firm_id = current_firm_id() order by created_at desc`,
      );
      const items = await client.query(
        `select * from purchase_material_request_items where firm_id = current_firm_id() order by order_index`,
      );
      const byReq = new Map<string, any[]>();
      for (const it of items.rows) {
        const arr = byReq.get(it.request_id) || [];
        arr.push({
          id: it.id, material_id: it.material_id ?? null, material_name: it.material_name ?? '',
          description: it.description ?? null, quantity: Number(it.quantity ?? 0), uom: it.uom ?? null,
          required_by: it.required_by ?? null, order_index: it.order_index ?? 0,
        });
        byReq.set(it.request_id, arr);
      }
      return reqs.rows.map((r) => ({
        id: r.id, request_number: r.request_number, request_date: r.request_date,
        project_id: r.project_id ?? null, plant_description: r.plant_description ?? null,
        total_days: r.total_days ?? null, engineer_id: r.engineer_id ?? null,
        status: r.status, client_requirements: r.client_requirements ?? [],
        notes: r.notes ?? null, created_by: r.created_by ?? null,
        created_at: r.created_at, updated_at: r.updated_at, items: byReq.get(r.id) || [],
      }));
    });
  }

  saveRequest(
    authUid: string,
    input: {
      id?: string;
      request_date: string;
      project_id: string | null;
      plant_description?: string | null;
      total_days?: number | null;
      engineer_id?: string | null;
      client_requirements: unknown[];
      notes?: string | null;
      items: { material_id: string | null; material_name: string; description?: string; quantity: number; uom: string; required_by?: string }[];
    },
    userId: string,
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const header = {
        request_date: input.request_date,
        project_id: input.project_id,
        plant_description: input.plant_description?.trim() || null,
        total_days: input.total_days ?? null,
        engineer_id: input.engineer_id || userId,
        client_requirements: JSON.stringify(input.client_requirements ?? []),
        notes: input.notes?.trim() || null,
      };
      let id = input.id;
      if (id) {
        await client.query(
          `update purchase_material_requests set request_date=$1, project_id=$2, plant_description=$3,
             total_days=$4, engineer_id=$5, client_requirements=$6::jsonb, notes=$7, updated_at=now()
           where id = $8 and firm_id = current_firm_id()`,
          [header.request_date, header.project_id, header.plant_description, header.total_days,
            header.engineer_id, header.client_requirements, header.notes, id],
        );
        await client.query(
          `delete from purchase_material_request_items where request_id = $1 and firm_id = current_firm_id()`,
          [id],
        );
      } else {
        const request_number = formatDocNumber('MR', await this.nextSeq(client, 'purchase_material_requests'));
        const { rows } = await client.query(
          `insert into purchase_material_requests
             (firm_id, created_by, request_number, status, request_date, project_id, plant_description,
              total_days, engineer_id, client_requirements, notes)
           values (current_firm_id(), $1, $2, 'open', $3, $4, $5, $6, $7, $8::jsonb, $9)
           returning id`,
          [userId, request_number, header.request_date, header.project_id, header.plant_description,
            header.total_days, header.engineer_id, header.client_requirements, header.notes],
        );
        id = rows[0].id;
      }
      await this.insertRequestItems(client, id!, input.items);
      return { id };
    });
  }

  private async insertRequestItems(
    client: PoolClient,
    requestId: string,
    items: { material_id: string | null; material_name: string; description?: string; quantity: number; uom: string; required_by?: string }[],
  ) {
    const rows = items.filter((i) => i.material_name?.trim() || i.material_id);
    for (let idx = 0; idx < rows.length; idx++) {
      const i = rows[idx];
      await client.query(
        `insert into purchase_material_request_items
           (firm_id, request_id, material_id, material_name, description, quantity, uom, required_by, order_index)
         values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [requestId, i.material_id, i.material_name.trim(), i.description?.trim() || null,
          i.quantity || 0, i.uom || null, i.required_by || null, idx],
      );
    }
  }

  async setRequestStatus(client: PoolClient, id: string, status: string) {
    await client.query(
      `update purchase_material_requests set status=$1, updated_at=now() where id=$2 and firm_id = current_firm_id()`,
      [status, id],
    );
  }

  /** Children deleted explicitly first — the same idiom deletePurchaseOrder
   * uses — so this is correct whether or not the FK cascades. */
  deleteRequest(authUid: string, id: string) {
    return this.db.withCaller(authUid, async (client) => {
      await client.query(
        `delete from purchase_material_request_items where request_id = $1 and firm_id = current_firm_id()`,
        [id],
      );
      await client.query(
        `delete from purchase_material_requests where id = $1 and firm_id = current_firm_id()`,
        [id],
      );
    });
  }

  // ═══ RFQs ════════════════════════════════════════════════════
  listRfqs(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const rfqs = await client.query(
        `select * from purchase_rfqs where firm_id = current_firm_id() order by created_at desc`,
      );
      const items = await client.query(
        `select * from purchase_rfq_items where firm_id = current_firm_id() order by order_index`,
      );
      const vendors = await client.query(
        `select * from purchase_rfq_vendors where firm_id = current_firm_id() order by order_index`,
      );
      const itemsBy = new Map<string, any[]>();
      for (const it of items.rows) {
        const arr = itemsBy.get(it.rfq_id) || [];
        arr.push({
          id: it.id, material_id: it.material_id ?? null, material_name: it.material_name ?? '',
          quantity: Number(it.quantity ?? 0), uom: it.uom ?? null,
          unit_price: it.unit_price == null ? null : Number(it.unit_price), order_index: it.order_index ?? 0,
        });
        itemsBy.set(it.rfq_id, arr);
      }
      const vendBy = new Map<string, any[]>();
      for (const v of vendors.rows) {
        const arr = vendBy.get(v.rfq_id) || [];
        arr.push({
          id: v.id, vendor_id: v.vendor_id ?? null, vendor_name: v.vendor_name ?? '', mobile: v.mobile ?? null,
          sent_date: v.sent_date ?? null, status: v.status,
          quoted_amount: v.quoted_amount == null ? null : Number(v.quoted_amount), order_index: v.order_index ?? 0,
        });
        vendBy.set(v.rfq_id, arr);
      }
      return rfqs.rows.map((r) => ({
        id: r.id, rfq_number: r.rfq_number, rfq_date: r.rfq_date, project_id: r.project_id ?? null,
        material_type: r.material_type ?? null, status: r.status, quote_valid_until: r.quote_valid_until ?? null,
        material_request_id: r.material_request_id ?? null, notes: r.notes ?? null, created_by: r.created_by ?? null,
        created_at: r.created_at, updated_at: r.updated_at,
        items: itemsBy.get(r.id) || [], vendors: vendBy.get(r.id) || [],
      }));
    });
  }

  saveRfq(
    authUid: string,
    input: {
      id?: string;
      rfq_date: string;
      project_id: string | null;
      material_type?: string | null;
      status: string;
      quote_valid_until?: string | null;
      material_request_id?: string | null;
      notes?: string | null;
      items: { material_id: string | null; material_name: string; quantity: number; uom?: string; rate?: number }[];
      vendors: { vendor_id: string | null; vendor_name: string; mobile: string | null; sent_date: string | null; status: string; quoted_amount: number | null }[];
    },
    userId: string,
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const header = {
        rfq_date: input.rfq_date,
        project_id: input.project_id,
        material_type: input.material_type?.trim() || null,
        status: input.status,
        quote_valid_until: input.quote_valid_until || null,
        material_request_id: input.material_request_id || null,
        notes: input.notes?.trim() || null,
      };
      let id = input.id;
      if (id) {
        await client.query(
          `update purchase_rfqs set rfq_date=$1, project_id=$2, material_type=$3, status=$4,
             quote_valid_until=$5, material_request_id=$6, notes=$7, updated_at=now()
           where id = $8`,
          [header.rfq_date, header.project_id, header.material_type, header.status,
            header.quote_valid_until, header.material_request_id, header.notes, id],
        );
        await client.query(`delete from purchase_rfq_items where rfq_id = $1`, [id]);
        await client.query(`delete from purchase_rfq_vendors where rfq_id = $1`, [id]);
      } else {
        const rfq_number = formatDocNumber('RFQ', await this.nextSeq(client, 'purchase_rfqs'));
        const { rows } = await client.query(
          `insert into purchase_rfqs
             (firm_id, created_by, rfq_number, rfq_date, project_id, material_type, status,
              quote_valid_until, material_request_id, notes)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning id`,
          [userId, rfq_number, header.rfq_date, header.project_id, header.material_type,
            header.status, header.quote_valid_until, header.material_request_id, header.notes],
        );
        id = rows[0].id;
      }
      const itemRows = input.items.filter((i) => i.material_name?.trim() || i.material_id);
      for (let idx = 0; idx < itemRows.length; idx++) {
        const i = itemRows[idx];
        await client.query(
          `insert into purchase_rfq_items (firm_id, rfq_id, material_id, material_name, quantity, uom, unit_price, order_index)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [id, i.material_id, i.material_name.trim(), i.quantity || 0, i.uom || null, i.rate || null, idx],
        );
      }
      const vendRows = input.vendors.filter((v) => v.vendor_name?.trim() || v.vendor_id);
      for (let idx = 0; idx < vendRows.length; idx++) {
        const v = vendRows[idx];
        await client.query(
          `insert into purchase_rfq_vendors (firm_id, rfq_id, vendor_id, vendor_name, mobile, sent_date, status, quoted_amount, order_index)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, v.vendor_id, v.vendor_name.trim(), v.mobile || null, v.sent_date || null, v.status, v.quoted_amount, idx],
        );
      }
      return { id };
    });
  }

  async setRfqStatus(client: PoolClient, id: string, status: string) {
    await client.query(`update purchase_rfqs set status=$1, updated_at=now() where id=$2`, [status, id]);
  }

  /** Children deleted explicitly first, same as deleteRequest. */
  deleteRfq(authUid: string, id: string) {
    return this.db.withCaller(authUid, async (client) => {
      await client.query(`delete from purchase_rfq_items where rfq_id = $1`, [id]);
      await client.query(`delete from purchase_rfq_vendors where rfq_id = $1`, [id]);
      await client.query(`delete from purchase_rfqs where id = $1`, [id]);
    });
  }

  /** Convert a material request into a draft RFQ (pre-filled items), mark request in_rfq. */
  createRfqFromRequest(authUid: string, requestId: string, userId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: reqRows } = await client.query(
        `select id, request_number, project_id from purchase_material_requests
          where id = $1 and firm_id = current_firm_id()`,
        [requestId],
      );
      if (!reqRows[0]) throw new Error('Material request not found');
      const req = reqRows[0];
      const { rows: items } = await client.query(
        `select material_id, material_name, quantity, uom from purchase_material_request_items
          where request_id = $1 order by order_index`,
        [requestId],
      );

      const rfq_number = formatDocNumber('RFQ', await this.nextSeq(client, 'purchase_rfqs'));
      const { rows: rfqRows } = await client.query(
        `insert into purchase_rfqs (firm_id, created_by, rfq_number, rfq_date, project_id, status, material_request_id, notes)
         values (current_firm_id(), $1, $2, current_date, $3, 'draft', $4, $5)
         returning id`,
        [userId, rfq_number, req.project_id, requestId, `From request ${req.request_number}`],
      );
      const rfqId = rfqRows[0].id;
      for (let idx = 0; idx < items.length; idx++) {
        const i = items[idx];
        await client.query(
          `insert into purchase_rfq_items (firm_id, rfq_id, material_id, material_name, quantity, uom, order_index)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6)`,
          [rfqId, i.material_id, i.material_name, i.quantity, i.uom || 'nos', idx],
        );
      }
      await this.setRequestStatus(client, requestId, 'in_rfq');
      return { id: rfqId, rfq_number };
    });
  }
}
