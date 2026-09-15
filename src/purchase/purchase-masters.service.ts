import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * Vendors (reuses `vendors` — shared with BOQ's own vendor directory, see
 * boq-vendor.service.ts) + Materials (reuses catalog_products /
 * catalog_products_effective / product_skus / rate_cards — the SAME tables
 * BOQ's admin module reads). Mirrors Vastos_ARC's src/purchase/masterApi.ts.
 *
 * Vendor writes are bespoke, not the generic /api/data/:table layer: this
 * table's `created_by` is a uuid FK to `profiles.id`, a different id space
 * than the `userId` (crm_profiles.id, text) the frontend holds, so it has to
 * be resolved server-side from the session the same way BOQ's own,
 * already-shipped vendor writes do (`select id from profiles where
 * auth_uid = $1`) — the generic layer has no per-column logic to do that.
 *
 * saveMaterial's update path goes through catalog_product_override_set, the
 * same H2b copy-on-write RPC boq-admin.service.ts's saveProductWaste already
 * proxies: the shared catalogue is read-only to every tenant, so a direct
 * UPDATE would reprice every other firm's estimates. New materials have no
 * server-generated field, so insert is plain SQL (RLS still requires
 * crm_has_permission('catalog','edit'), same as it always did).
 */
@Injectable()
export class PurchaseMastersService {
  constructor(private readonly db: DatabaseService) {}

  listVendors(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select id, company_name, vendor_code, contact_person, phone, email, gstin,
                category, credit_days, payment_terms, status, notes, overall_score
           from vendors
          where firm_id = current_firm_id()
          order by company_name`,
      );
      return rows.map((v) => ({
        ...v,
        overall_score: v.overall_score == null ? null : Number(v.overall_score),
      }));
    });
  }

  saveVendor(
    authUid: string,
    input: {
      id?: string;
      company_name: string;
      vendor_code?: string | null;
      contact_person?: string | null;
      phone?: string | null;
      email?: string | null;
      gstin?: string | null;
      category?: string | null;
      credit_days?: number | null;
      payment_terms?: string | null;
      status: string;
      notes?: string | null;
    },
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const fields = {
        company_name: input.company_name.trim(),
        vendor_code: input.vendor_code?.trim() || null,
        contact_person: input.contact_person?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        gstin: input.gstin?.trim() || null,
        category: input.category?.trim() || null,
        credit_days: input.credit_days ?? null,
        payment_terms: input.payment_terms?.trim() || null,
        status: input.status,
        notes: input.notes?.trim() || null,
      };
      if (input.id) {
        await client.query(
          `update vendors set company_name=$1, vendor_code=$2, contact_person=$3, phone=$4,
             email=$5, gstin=$6, category=$7, credit_days=$8, payment_terms=$9, status=$10, notes=$11
           where id = $12`,
          [
            fields.company_name, fields.vendor_code, fields.contact_person, fields.phone,
            fields.email, fields.gstin, fields.category, fields.credit_days,
            fields.payment_terms, fields.status, fields.notes, input.id,
          ],
        );
        return { id: input.id };
      }
      const { rows: meRows } = await client.query<{ id: string }>(
        `select id from profiles where auth_uid = $1 limit 1`,
        [authUid],
      );
      const createdBy = meRows[0]?.id ?? null;
      const { rows } = await client.query<{ id: string }>(
        `insert into vendors (firm_id, created_by, company_name, vendor_code, contact_person, phone,
            email, gstin, category, credit_days, payment_terms, status, notes)
         values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          createdBy, fields.company_name, fields.vendor_code, fields.contact_person, fields.phone,
          fields.email, fields.gstin, fields.category, fields.credit_days,
          fields.payment_terms, fields.status, fields.notes,
        ],
      );
      return { id: rows[0].id };
    });
  }

  deleteVendor(authUid: string, id: string) {
    return this.db.withCaller(authUid, (client) => client.query(`delete from vendors where id = $1`, [id]));
  }

  listCatalogCategories(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query(
        `select id, name, path from catalog_categories order by path`,
      );
      return rows;
    });
  }

  /** Mirrors masterApi.ts's listMaterials: one effective-row-per-product view,
   * joined client-side (well, server-side now) against categories/skus/rate
   * cards for the "last price" figure. No explicit firm filter on the
   * `catalog_products_effective` select itself — the view already resolves
   * global-vs-override per firm, exactly as the working Supabase query did. */
  listMaterials(authUid: string) {
    return this.db.withCaller(authUid, async (client) => {
      // One transaction is one connection: awaited in turn, not Promise.all'd
      // (concurrent client.query() on one pg client is deprecated in pg 8).
      const products = await client.query(
        `select id, name, category_id, base_uom, hsn_code, gst_rate, is_active
           from catalog_products_effective order by name`,
      );
      const cats = await client.query(`select id, name from catalog_categories`);
      const skus = await client.query(`select id, product_id from product_skus`);
      const rates = await client.query(
        `select sku_id, rate, region_id, valid_from from rate_cards
          where firm_id = current_firm_id() and sku_id is not null`,
      );

      const catName = new Map<string, string>(cats.rows.map((c) => [c.id, c.name]));
      const productOfSku = new Map<string, string>(skus.rows.map((s) => [s.id, s.product_id]));

      const lastPrice = new Map<string, { rate: number; when: string }>();
      for (const r of rates.rows) {
        if (r.region_id) continue; // national base only
        const pid = productOfSku.get(r.sku_id);
        if (!pid) continue;
        const when = r.valid_from || '';
        const cur = lastPrice.get(pid);
        if (!cur || when >= cur.when) lastPrice.set(pid, { rate: Number(r.rate), when });
      }

      return products.rows.map((p) => ({
        id: p.id,
        name: p.name,
        category_id: p.category_id ?? null,
        category: p.category_id ? catName.get(p.category_id) ?? null : null,
        base_uom: p.base_uom,
        hsn_code: p.hsn_code ?? null,
        gst_rate: Number(p.gst_rate ?? 18),
        last_price: lastPrice.get(p.id)?.rate ?? null,
        is_active: p.is_active !== false,
      }));
    });
  }

  saveMaterial(
    authUid: string,
    input: {
      id?: string;
      name: string;
      category_id: string;
      base_uom: string;
      hsn_code?: string | null;
      gst_rate: number;
      description?: string | null;
    },
  ) {
    return this.db.withCaller(authUid, async (client) => {
      const fields: Record<string, unknown> = {
        name: input.name.trim(),
        category_id: input.category_id,
        base_uom: input.base_uom,
        hsn_code: input.hsn_code?.trim() || null,
        gst_rate: input.gst_rate,
      };
      if (input.description?.trim()) {
        fields.attributes = { description: input.description.trim() };
      }
      if (input.id) {
        // catalog_product_override_set has its own field allowlist and
        // base_uom isn't in it — the RPC treats a product's unit of measure
        // as immutable once created (changing it after estimates/rate cards/
        // PO lines reference the product would corrupt their quantity math),
        // and rejects any unknown key rather than silently dropping it.
        // masterApi.ts's original Supabase-js code sent base_uom in this
        // patch unconditionally — a pre-existing bug that made every
        // material edit throw (caught live by this migration's own
        // verification probe, not something introduced here); dropped here
        // rather than replicated.
        const { base_uom: _omitted, ...patch } = fields;
        await client.query(`select catalog_product_override_set($1, $2::jsonb)`, [
          input.id,
          JSON.stringify(patch),
        ]);
        return { id: input.id };
      }
      // firm_id from the session, not the client — matches BOQ's bespoke
      // services, which always write current_firm_id() inline rather than
      // trusting a client-supplied firm id.
      const { rows } = await client.query(
        `insert into catalog_products (firm_id, is_active, name, category_id, base_uom, hsn_code, gst_rate, attributes)
         values (current_firm_id(), true, $1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb))
         returning id`,
        [
          fields.name,
          fields.category_id,
          fields.base_uom,
          fields.hsn_code,
          fields.gst_rate,
          fields.attributes ? JSON.stringify(fields.attributes) : null,
        ],
      );
      return { id: rows[0].id };
    });
  }

  /** Soft-delete: hides the material for THIS firm only, as an override —
   * same H2b semantics as saveMaterial's update path. */
  deactivateMaterial(authUid: string, id: string) {
    return this.db.withCaller(authUid, (client) =>
      client.query(`select catalog_product_override_set($1, $2::jsonb)`, [
        id,
        JSON.stringify({ is_active: false }),
      ]),
    );
  }
}
