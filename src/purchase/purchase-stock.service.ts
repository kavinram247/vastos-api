import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { formatDocNumber } from './purchase-logic';

/**
 * Project Stock (list only — StockTab's own save/delete go through
 * /api/data/project_stock, see db/table-registry.ts; the PO-receipt flow's
 * match-or-create upsert into this same table is bespoke SQL in
 * purchase-orders.service.ts) + Work Orders (fully bespoke — wo_number is
 * server-generated, same shape as MR/RFQ/PO numbering).
 * `work_orders.created_by` is plain text (no FK), like tasks.created_by_id —
 * the client-supplied userId is trusted directly, no profiles lookup needed.
 */
@Injectable()
export class PurchaseStockService {
  constructor(private readonly db: DatabaseService) {}

  listStock(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from project_stock where firm_id = current_firm_id() order by material_name`,
      );
      return rows.map((s) => ({
        ...s,
        current_stock: Number(s.current_stock ?? 0),
        reorder_level: Number(s.reorder_level ?? 0),
      }));
    });
  }

  listWorkOrders(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select * from work_orders where firm_id = current_firm_id() order by created_at desc`,
      );
      return rows.map((w) => ({ ...w, amount: w.amount == null ? null : Number(w.amount) }));
    });
  }

  saveWorkOrder(
    authUid: string,
    input: {
      id?: string; title: string; project_id: string | null; contractor_vendor_id: string | null;
      wo_date: string; amount: number | null; status: string; work_description?: string | null;
      terms_of_payment?: string | null; terms_conditions?: string | null; additional_work?: string | null;
      bank_details?: string | null; notes?: string | null;
    },
    userId: string,
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const fields = {
        title: input.title.trim(), project_id: input.project_id, contractor_vendor_id: input.contractor_vendor_id,
        wo_date: input.wo_date, amount: input.amount, status: input.status,
        work_description: input.work_description?.trim() || null,
        terms_of_payment: input.terms_of_payment?.trim() || null,
        terms_conditions: input.terms_conditions?.trim() || null,
        additional_work: input.additional_work?.trim() || null,
        bank_details: input.bank_details?.trim() || null, notes: input.notes?.trim() || null,
      };
      if (input.id) {
        await client.query(
          `update work_orders set title=$1, project_id=$2, contractor_vendor_id=$3, wo_date=$4, amount=$5,
             status=$6, work_description=$7, terms_of_payment=$8, terms_conditions=$9, additional_work=$10,
             bank_details=$11, notes=$12, updated_at=now()
           where id = $13 and firm_id = current_firm_id()`,
          [fields.title, fields.project_id, fields.contractor_vendor_id, fields.wo_date, fields.amount,
            fields.status, fields.work_description, fields.terms_of_payment, fields.terms_conditions,
            fields.additional_work, fields.bank_details, fields.notes, input.id],
        );
        return { id: input.id };
      }
      const { rows: seqRows } = await client.query(
        `select count(*)::int as n from work_orders where firm_id = current_firm_id()`,
      );
      const wo_number = formatDocNumber('WO', (seqRows[0]?.n ?? 0) + 1);
      const { rows } = await client.query(
        `insert into work_orders (firm_id, created_by, wo_number, title, project_id, contractor_vendor_id,
            wo_date, amount, status, work_description, terms_of_payment, terms_conditions, additional_work,
            bank_details, notes)
         values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning id, wo_number`,
        [userId, wo_number, fields.title, fields.project_id, fields.contractor_vendor_id, fields.wo_date,
          fields.amount, fields.status, fields.work_description, fields.terms_of_payment,
          fields.terms_conditions, fields.additional_work, fields.bank_details, fields.notes],
      );
      return { id: rows[0].id, wo_number: rows[0].wo_number };
    });
  }

  deleteWorkOrder(authUid: string, id: string) {
    return this.db.withCaller(authUid, (client) =>
      client.query(`delete from work_orders where id = $1 and firm_id = current_firm_id()`, [id]),
    );
  }
}
