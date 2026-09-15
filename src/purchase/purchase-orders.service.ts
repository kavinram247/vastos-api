import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import { PurchaseDocsService } from './purchase-docs.service';
import { computePoTotals, formatDocNumber, uomToEnum } from './purchase-logic';

interface PoItemInput {
  material_id: string | null;
  material_name: string;
  description?: string;
  quantity: number;
  uom: string;
  rate: number;
}

interface PoHeaderFields {
  project_id: string | null; // crm_projects.id — see the column-mapping note below
  vendor_id: string | null;
  rfq_id?: string | null; // purchase_rfqs.id
  material_request_id?: string | null; // purchase_material_requests.id
  material_type?: string | null;
  required_by?: string | null;
  delivery_date?: string | null;
  delivery_address?: string | null;
  credit_days?: number | null;
  supplier_quotation_ref?: string | null;
  gst_rate: number;
  gst_type: 'inclusive' | 'exclusive';
  freight_charges: number;
  order_contact_id?: string | null;
  order_contact_phone?: string | null;
  delivery_contact_id?: string | null;
  delivery_contact_phone?: string | null;
  additional_terms?: string | null;
  notes?: string | null;
}

/**
 * Purchase Orders — the unified ledger (reuses `purchase_orders` +
 * `po_line_items`, shared with BOQ's generatePO and Inventory's
 * inv_save_purchase_order). Mirrors Vastos_ARC's src/purchase/poApi.ts.
 *
 * COLUMN MAPPING TRAP (read before touching this file): `purchase_orders`
 * carries two generations of link columns. The original migration 28 added
 * `project_id` (uuid, FK -> a `projects` table), `rfq_id` (uuid, FK -> a
 * `rfqs` table) and `material_request_id` (uuid, FK -> a `material_requests`
 * table) — poApi.ts (the Supabase-js original) still writes these. But
 * `projects`/`rfqs`/`material_requests` turned out to be a DIFFERENT set of
 * tables than the ones this module (or any other) actually populates:
 * `material_requests`/`rfqs` are Inventory's own MR/RFQ tables (its
 * inv_save_material_request/inv_save_purchase_order RPCs write them), and
 * `projects` has zero rows in production — real projects live in
 * `crm_projects`, which has a TEXT id ("proj-1", not a uuid). Inventory's own
 * migration (20260703191743_inventory_d_rpc_core_mr_po.sql) added three
 * "correctly-scoped" columns for exactly this reason: `crm_project_id`
 * (text -> crm_projects), `purchase_rfq_id` (uuid -> purchase_rfqs),
 * `purchase_material_request_id` (uuid -> purchase_material_requests).
 * Replicating poApi.ts's original columns verbatim would make every save
 * with a linked project/RFQ/request throw (invalid uuid syntax for
 * "proj-1", or an FK violation into an empty ghost table) — confirmed via
 * `purchase_orders` having zero rows in prod, i.e. this path has never
 * actually been exercised with a non-null link. This service writes the
 * *_project_id / purchase_rfq_id / purchase_material_request_id columns
 * instead — the same ones Inventory's own RPCs use — while keeping the
 * frontend-facing field names (`project_id`, `rfq_id`, `material_request_id`)
 * unchanged on read, so PurchaseOrder's shape doesn't change for callers.
 *
 * created_by is a uuid FK to `profiles.id`, a different id space than the
 * `userId` (crm_profiles.id, text) callers pass — resolved server-side from
 * the session the same way BOQ's vendor writes do.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly docs: PurchaseDocsService,
  ) {}

  private mapPo(p: any, items: any[], payments: any[]) {
    return {
      id: p.id, po_number: p.po_number,
      project_id: p.crm_project_id ?? null, // see column-mapping note above
      vendor_id: p.vendor_id ?? null, boq_id: p.boq_id ?? null,
      rfq_id: p.purchase_rfq_id ?? null, material_request_id: p.purchase_material_request_id ?? null,
      material_type: p.material_type ?? null, status: p.status,
      payment_status: p.payment_status ?? 'outstanding', approval_status: p.approval_status ?? 'draft',
      po_date: p.created_at, required_by: p.required_by ?? null, delivery_date: p.delivery_date ?? null,
      delivery_address: p.delivery_address ?? null, credit_days: p.credit_days ?? null,
      supplier_quotation_ref: p.supplier_quotation_ref ?? null,
      gst_rate: Number(p.gst_rate ?? 18), gst_type: p.gst_type ?? 'inclusive',
      freight_charges: Number(p.freight_charges ?? 0), subtotal: Number(p.subtotal ?? 0),
      gst_amount: Number(p.gst_amount ?? 0), total_amount: Number(p.total_amount ?? 0),
      order_contact_id: p.order_contact_id ?? null, order_contact_phone: p.order_contact_phone ?? null,
      delivery_contact_id: p.delivery_contact_id ?? null, delivery_contact_phone: p.delivery_contact_phone ?? null,
      additional_terms: p.additional_terms ?? null, notes: p.notes ?? null, admin_notes: p.admin_notes ?? null,
      created_by: p.created_by ?? null, created_at: p.created_at,
      items: items.map((it) => ({
        id: it.id, material_id: it.sku_id ?? null, description: it.description ?? '',
        quantity: Number(it.quantity ?? 0), uom: it.uom ?? 'nos', rate: Number(it.rate ?? 0),
        amount: Number(it.amount ?? 0), qty_received: Number(it.qty_received ?? 0),
      })),
      payments: payments.map((pm) => ({
        id: pm.id, payment_date: pm.payment_date, amount: Number(pm.amount ?? 0),
        payment_mode: pm.payment_mode ?? null, reference_no: pm.reference_no ?? null,
      })),
    };
  }

  listPurchaseOrders(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      // One transaction is one connection: awaited in turn, not Promise.all'd
      // (concurrent client.query() on one pg client is deprecated in pg 8).
      const pos = await client.query(
        `select * from purchase_orders where firm_id = current_firm_id() order by created_at desc`,
      );
      const items = await client.query(`select * from po_line_items where firm_id = current_firm_id()`);
      const pays = await client.query(
        `select * from po_payments where firm_id = current_firm_id() order by payment_date`,
      );
      const itemsBy = new Map<string, any[]>();
      for (const it of items.rows) itemsBy.set(it.po_id, [...(itemsBy.get(it.po_id) || []), it]);
      const paysBy = new Map<string, any[]>();
      for (const p of pays.rows) paysBy.set(p.po_id, [...(paysBy.get(p.po_id) || []), p]);
      return pos.rows.map((p) => this.mapPo(p, itemsBy.get(p.id) || [], paysBy.get(p.id) || []));
    });
  }

  private async resolveCreatedBy(client: PoolClient, authUid: string): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      `select id from profiles where auth_uid = $1 limit 1`,
      [authUid],
    );
    return rows[0]?.id ?? null;
  }

  /** Insert a brand-new PO (header + line items). Shared by savePurchaseOrder
   * (new-PO branch) and the RFQ/request conversion flows, all within one
   * caller-supplied transaction. */
  private async insertNewPo(
    client: PoolClient,
    createdBy: string | null,
    fields: PoHeaderFields,
    items: PoItemInput[],
    approvalStatus: 'draft' | 'pending',
  ): Promise<{ id: string; po_number: string }> {
    const totals = computePoTotals(items, fields.gst_rate, fields.gst_type, fields.freight_charges);
    const { rows: seqRows } = await client.query(
      `select count(*)::int as n from purchase_orders where firm_id = current_firm_id()`,
    );
    const po_number = formatDocNumber('PO', (seqRows[0]?.n ?? 0) + 1);

    const { rows } = await client.query(
      `insert into purchase_orders
         (firm_id, created_by, po_number, status, crm_project_id, vendor_id, purchase_rfq_id,
          purchase_material_request_id, material_type, required_by, delivery_date, delivery_address,
          credit_days, supplier_quotation_ref, gst_rate, gst_type, freight_charges, subtotal, gst_amount,
          total_amount, order_contact_id, order_contact_phone, delivery_contact_id, delivery_contact_phone,
          additional_terms, notes, approval_status)
       values (current_firm_id(), $1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       returning id, po_number`,
      [
        createdBy, po_number, fields.project_id, fields.vendor_id, fields.rfq_id || null,
        fields.material_request_id || null, fields.material_type?.trim() || null,
        fields.required_by || null, fields.delivery_date || null, fields.delivery_address?.trim() || null,
        fields.credit_days ?? null, fields.supplier_quotation_ref?.trim() || null, fields.gst_rate,
        fields.gst_type, fields.freight_charges, totals.subtotal, totals.gst, totals.total,
        fields.order_contact_id || null, fields.order_contact_phone?.trim() || null,
        fields.delivery_contact_id || null, fields.delivery_contact_phone?.trim() || null,
        fields.additional_terms?.trim() || null, fields.notes?.trim() || null, approvalStatus,
      ],
    );
    const id = rows[0].id;
    await this.insertLineItems(client, id, items);
    return { id, po_number };
  }

  private async insertLineItems(client: PoolClient, poId: string, items: PoItemInput[]) {
    const rows = items.filter((i) => i.material_name?.trim() || i.description?.trim() || i.material_id);
    for (const i of rows) {
      const amount = Math.round((i.quantity || 0) * (i.rate || 0) * 100) / 100;
      // po_line_items.sku_id FKs to product_skus.id — a different, more
      // granular id space than i.material_id, which is always a
      // catalog_products.id here (Purchase Management's own material picker,
      // masterApi.ts's listMaterials, is product-level and has never dealt in
      // SKUs). poApi.ts's original Supabase-js code wrote sku_id: i.material_id
      // directly — a pre-existing bug that would FK-violate on every PO line
      // with a picked material (caught live by this migration's verification
      // probe, never exercised in production: purchase_orders had zero rows).
      // Left null here rather than replicated; description/quantity/uom/rate
      // — what actually matters for a PO line — are unaffected.
      await client.query(
        `insert into po_line_items (firm_id, po_id, sku_id, description, uom, quantity, rate, amount, qty_received)
         values (current_firm_id(), $1, null, $2, $3, $4, $5, $6, 0)`,
        [poId, i.description?.trim() || i.material_name.trim(), uomToEnum(i.uom), i.quantity || 0, i.rate || 0, amount],
      );
    }
  }

  savePurchaseOrder(
    authUid: string,
    input: PoHeaderFields & { id?: string; items: PoItemInput[]; submitForApproval?: boolean },
  ) {
    return this.db.withCaller(authUid, async (client) => {
      if (input.id) {
        const totals = computePoTotals(input.items, input.gst_rate, input.gst_type, input.freight_charges);
        const approval_status = input.submitForApproval ? 'pending' : 'draft';
        await client.query(
          `update purchase_orders set
             crm_project_id=$1, vendor_id=$2, purchase_rfq_id=$3, purchase_material_request_id=$4,
             material_type=$5, required_by=$6, delivery_date=$7, delivery_address=$8, credit_days=$9,
             supplier_quotation_ref=$10, gst_rate=$11, gst_type=$12, freight_charges=$13, subtotal=$14,
             gst_amount=$15, total_amount=$16, order_contact_id=$17, order_contact_phone=$18,
             delivery_contact_id=$19, delivery_contact_phone=$20, additional_terms=$21, notes=$22,
             approval_status=$23, updated_at=now()
           where id = $24 and firm_id = current_firm_id()`,
          [
            input.project_id, input.vendor_id, input.rfq_id || null, input.material_request_id || null,
            input.material_type?.trim() || null, input.required_by || null, input.delivery_date || null,
            input.delivery_address?.trim() || null, input.credit_days ?? null,
            input.supplier_quotation_ref?.trim() || null, input.gst_rate, input.gst_type,
            input.freight_charges, totals.subtotal, totals.gst, totals.total, input.order_contact_id || null,
            input.order_contact_phone?.trim() || null, input.delivery_contact_id || null,
            input.delivery_contact_phone?.trim() || null, input.additional_terms?.trim() || null,
            input.notes?.trim() || null, approval_status, input.id,
          ],
        );
        await client.query(`delete from po_line_items where po_id = $1 and firm_id = current_firm_id()`, [input.id]);
        await this.insertLineItems(client, input.id, input.items);
        return { id: input.id, po_number: null as string | null };
      }
      const createdBy = await this.resolveCreatedBy(client, authUid);
      const approvalStatus = input.submitForApproval ? 'pending' : 'draft';
      return this.insertNewPo(client, createdBy, input, input.items, approvalStatus);
    });
  }

  submitForApproval(authUid: string, id: string) {
    return this.db.withCaller(authUid, (client) =>
      client.query(
        `update purchase_orders set approval_status='pending' where id=$1 and firm_id = current_firm_id()`,
        [id],
      ),
    );
  }

  /** Goes through approve_purchase_order() — audit H4. See poApi.ts's own
   * comment: the RPC re-derives the actor from auth.uid(), enforces firm
   * binding + purchase:approve + segregation of duties; the UI gating on the
   * frontend is convenience only. */
  decidePoApproval(authUid: string, id: string, decision: 'approved' | 'rejected', notes: string | null) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select approve_purchase_order($1, $2, $3) as result`,
        [id, decision, notes],
      );
      return rows[0]?.result;
    });
  }

  addPayment(
    authUid: string,
    id: string,
    payment: { payment_date: string; amount: number; payment_mode: string | null; reference_no: string | null },
  ) {
    return this.db.withCaller(authUid, async (client) => {
      await client.query(
        `insert into po_payments (firm_id, po_id, payment_date, amount, payment_mode, reference_no)
         values (current_firm_id(), $1, $2, $3, $4, $5)`,
        [id, payment.payment_date, payment.amount, payment.payment_mode, payment.reference_no],
      );
      const { rows } = await client.query(
        `select coalesce(sum(amount),0) as paid, (select total_amount from purchase_orders where id=$1) as total
           from po_payments where po_id = $1`,
        [id],
      );
      const paid = Number(rows[0]?.paid ?? 0);
      const total = Number(rows[0]?.total ?? 0);
      const payment_status = paid <= 0 ? 'outstanding' : paid + 0.01 >= total ? 'paid' : 'partial';
      await client.query(`update purchase_orders set payment_status=$1 where id=$2`, [payment_status, id]);
    });
  }

  /** Mark a PO fully received and flow its line quantities into project
   * stock — the match-or-create upsert Vastos_ARC's docsApi.ts calls
   * receiveIntoStock, reimplemented inline here (bespoke SQL, same as the
   * original; not routed through /api/data/project_stock's generic writer,
   * which has no such conditional-match semantics). */
  receivePurchaseOrder(authUid: string, id: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: poRows } = await client.query(
        `select id, crm_project_id from purchase_orders where id=$1 and firm_id = current_firm_id()`,
        [id],
      );
      if (!poRows[0]) throw new Error('Purchase order not found');
      const projectId: string | null = poRows[0].crm_project_id;

      const { rows: items } = await client.query(
        `select id, sku_id, description, uom, quantity from po_line_items where po_id = $1`,
        [id],
      );
      for (const it of items) {
        await client.query(`update po_line_items set qty_received = quantity where id = $1`, [it.id]);
        await this.receiveIntoStock(client, projectId, it.sku_id, it.description, it.uom, Number(it.quantity), id);
      }
      await client.query(
        `update purchase_orders set status='received', received_at=now() where id=$1 and firm_id = current_firm_id()`,
        [id],
      );
    });
  }

  private async receiveIntoStock(
    client: PoolClient, projectId: string | null, materialId: string | null,
    materialName: string, uom: string | null, qty: number, poId: string,
  ) {
    const matchCol = materialId ? 'material_id = $1' : 'material_name = $1';
    const projectCol = projectId ? 'project_id = $2' : 'project_id is null';
    const { rows: existing } = await client.query(
      `select id, current_stock from project_stock
        where firm_id = current_firm_id() and ${matchCol} and ${projectCol} limit 1`,
      projectId ? [materialId || materialName, projectId] : [materialId || materialName],
    );
    if (existing[0]) {
      await client.query(
        `update project_stock set current_stock = $1, last_po_id = $2, last_updated = current_date, updated_at = now()
          where id = $3`,
        [Number(existing[0].current_stock || 0) + qty, poId, existing[0].id],
      );
    } else {
      await client.query(
        `insert into project_stock (firm_id, project_id, material_id, material_name, uom, current_stock, reorder_level, last_po_id, last_updated)
         values (current_firm_id(), $1, $2, $3, $4, $5, 0, $6, current_date)`,
        [projectId, materialId, materialName, uom, qty, poId],
      );
    }
  }

  deletePurchaseOrder(authUid: string, id: string) {
    return this.db.withCaller(authUid, async (client) => {
      await client.query(`delete from po_line_items where po_id = $1 and firm_id = current_firm_id()`, [id]);
      await client.query(`delete from po_payments where po_id = $1 and firm_id = current_firm_id()`, [id]);
      await client.query(`delete from purchase_orders where id = $1 and firm_id = current_firm_id()`, [id]);
    });
  }

  // ── conversions (Material Requests / RFQ -> PO) ──
  createPoFromRfq(authUid: string, rfqId: string, userId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: rfqRows } = await client.query(
        `select id, rfq_number, project_id, material_type, material_request_id from purchase_rfqs
          where id = $1 and firm_id = current_firm_id()`,
        [rfqId],
      );
      if (!rfqRows[0]) throw new Error('RFQ not found');
      const rfq = rfqRows[0];
      const { rows: items } = await client.query(
        `select material_id, material_name, quantity, uom, unit_price from purchase_rfq_items
          where rfq_id = $1 order by order_index`,
        [rfqId],
      );
      const { rows: vendors } = await client.query(
        `select vendor_id, status from purchase_rfq_vendors where rfq_id = $1 order by order_index`,
        [rfqId],
      );
      const bestVendor = vendors.find((v) => v.status === 'responded') || vendors[0];

      const poItems: PoItemInput[] = items.map((i) => ({
        material_id: i.material_id, material_name: i.material_name,
        description: i.material_name, quantity: Number(i.quantity), uom: i.uom || 'nos',
        rate: i.unit_price != null ? Number(i.unit_price) : 0,
      }));
      const createdBy = await this.resolveCreatedBy(client, authUid);
      const { id } = await this.insertNewPo(
        client, createdBy,
        {
          project_id: rfq.project_id, vendor_id: bestVendor?.vendor_id || null, rfq_id: rfq.id,
          material_request_id: rfq.material_request_id, material_type: rfq.material_type,
          gst_rate: 18, gst_type: 'inclusive', freight_charges: 0, notes: `From RFQ ${rfq.rfq_number}`,
        },
        poItems, 'draft',
      );
      await this.docs.setRfqStatus(client, rfqId, 'closed');
      if (rfq.material_request_id) await this.docs.setRequestStatus(client, rfq.material_request_id, 'in_po');
      return { id };
    });
  }

  createPoFromRequest(authUid: string, requestId: string, userId: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: reqRows } = await client.query(
        `select id, request_number, project_id from purchase_material_requests
          where id = $1 and firm_id = current_firm_id()`,
        [requestId],
      );
      if (!reqRows[0]) throw new Error('Material request not found');
      const req = reqRows[0];
      const { rows: items } = await client.query(
        `select material_id, material_name, quantity, uom, required_by from purchase_material_request_items
          where request_id = $1 order by order_index`,
        [requestId],
      );
      const poItems: PoItemInput[] = items.map((i) => ({
        material_id: i.material_id, material_name: i.material_name,
        description: i.material_name, quantity: Number(i.quantity), uom: i.uom || 'nos', rate: 0,
      }));
      const requiredBy = items.find((i) => i.required_by)?.required_by || null;
      const createdBy = await this.resolveCreatedBy(client, authUid);
      const { id } = await this.insertNewPo(
        client, createdBy,
        {
          project_id: req.project_id, vendor_id: null, material_request_id: requestId,
          gst_rate: 18, gst_type: 'inclusive', freight_charges: 0, required_by: requiredBy,
          notes: `From request ${req.request_number}`,
        },
        poItems, 'draft',
      );
      await this.docs.setRequestStatus(client, requestId, 'in_po');
      return { id };
    });
  }
}
