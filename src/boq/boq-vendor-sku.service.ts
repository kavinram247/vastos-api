import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { BoqVendorService } from './boq-vendor.service';
import type { VendorScore } from './vendor-score-engine';

// ── JSON-friendly mirrors of Vastos_ARC's src/boq/vendorApi.ts types ────────
// SKU-linking/candidates/PO generation half of vendorApi.ts — core
// vendor+scoring+directory is in boq-vendor.service.ts instead (split to
// stay under the 500-line cap).

export interface VendorCandidate {
  vendor_id: string;
  company_name: string;
  price: number;
  lead_time_days: number;
  moq: number | null;
  score: VendorScore | null;
}

export interface POLineInput {
  sku_id: string | null;
  description: string;
  uom: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface VendorSkuLink {
  id: string;
  sku_id: string;
  sku_code: string;
  product: string;
  brand: string | null;
  category: string;
  price: number;
  moq: number | null;
  lead_time_days: number;
}

export interface SkuOption {
  sku_id: string;
  sku_code: string;
  brand: string | null;
  product: string;
  category: string;
  cat_path: string;
}

export interface VendorSkuInput {
  price: number;
  moq: number | null;
  lead_time_days: number;
}

/**
 * Vendor SKU linking, candidate ranking inputs and PO generation
 * (Vastos_ARC's src/boq/vendorApi.ts). Depends on BoqVendorService only for
 * its public fetchVendorsWithScores() (candidate scoring) — see that file's
 * class doc for why this is two transactions rather than one shared.
 */
@Injectable()
export class BoqVendorSkuService {
  constructor(
    private readonly db: DatabaseService,
    private readonly vendorScores: BoqVendorService,
  ) {}

  /** Vendors that sell a given SKU, with price/lead/MOQ + their score —
   * candidates for ranking (rankVendors() stays client-side). */
  async fetchCandidatesForSku(authUid: string, skuId: string): Promise<VendorCandidate[]> {
    const [vs, scored] = await Promise.all([
      this.db.withCaller(authUid, (client) =>
        client.query<{
          vendor_id: string;
          price: string;
          moq: string | null;
          lead_time_days: number;
          company_name: string | null;
        }>(
          `select vs.vendor_id, vs.price, vs.moq, vs.lead_time_days, v.company_name
             from vendor_skus vs
             join vendors v on v.id = vs.vendor_id
            where vs.firm_id = current_firm_id() and vs.sku_id = $1`,
          [skuId],
        ),
      ),
      this.vendorScores.fetchVendorsWithScores(authUid),
    ]);
    const scoreById = new Map(scored.map((s) => [s.id, s.score]));
    return vs.rows.map((r) => ({
      vendor_id: r.vendor_id,
      company_name: r.company_name ?? '—',
      price: Number(r.price),
      lead_time_days: r.lead_time_days,
      moq: r.moq == null ? null : Number(r.moq),
      score: scoreById.get(r.vendor_id) ?? null,
    }));
  }

  /** All vendor offers keyed by sku_id, with scores attached — for the PO
   * recommendation flow. Returned as a plain object (sku_id -> candidates[]);
   * the frontend reconstructs the Map its callers expect, same convention as
   * every other Map-shaped type from this migration. */
  async fetchCandidateMap(authUid: string): Promise<Record<string, VendorCandidate[]>> {
    const [vs, scored] = await Promise.all([
      this.db.withCaller(authUid, (client) =>
        client.query<{
          vendor_id: string;
          sku_id: string;
          price: string;
          moq: string | null;
          lead_time_days: number;
          company_name: string | null;
        }>(
          `select vs.vendor_id, vs.sku_id, vs.price, vs.moq, vs.lead_time_days, v.company_name
             from vendor_skus vs
             join vendors v on v.id = vs.vendor_id
            where vs.firm_id = current_firm_id()`,
        ),
      ),
      this.vendorScores.fetchVendorsWithScores(authUid),
    ]);
    const scoreById = new Map(scored.map((s) => [s.id, s.score]));
    const map: Record<string, VendorCandidate[]> = {};
    for (const r of vs.rows) {
      const arr = map[r.sku_id] ?? (map[r.sku_id] = []);
      arr.push({
        vendor_id: r.vendor_id,
        company_name: r.company_name ?? '—',
        price: Number(r.price),
        lead_time_days: r.lead_time_days,
        moq: r.moq == null ? null : Number(r.moq),
        score: scoreById.get(r.vendor_id) ?? null,
      });
    }
    return map;
  }

  listVendorSkus(authUid: string): Promise<Array<{ sku_id: string; label: string }>> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{
        sku_id: string;
        sku_code: string;
        brand: string | null;
        product_name: string | null;
      }>(
        `select vs.sku_id, ps.sku_code, ps.brand, cp.name as product_name
           from vendor_skus vs
           join product_skus ps on ps.id = vs.sku_id
           left join catalog_products cp on cp.id = ps.product_id
          where vs.firm_id = current_firm_id()`,
      );
      const seen = new Map<string, { sku_id: string; label: string }>();
      for (const r of rows) {
        if (seen.has(r.sku_id)) continue;
        const name = r.product_name || r.sku_code || 'SKU';
        seen.set(r.sku_id, { sku_id: r.sku_id, label: `${name} — ${r.brand ?? ''}`.trim() });
      }
      return [...seen.values()];
    });
  }

  /** purchase_orders + po_line_items in one transaction — the frontend
   * original did the PO-number count, the PO insert and the line-item insert
   * as three separate round trips with no rollback. */
  generatePO(
    authUid: string,
    boqId: string,
    vendorId: string,
    lines: POLineInput[],
  ): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: countRows } = await client.query<{ count: string }>(
        `select count(*) from purchase_orders where firm_id = current_firm_id()`,
      );
      const poNumber = `PO-${new Date().getFullYear()}-${String(Number(countRows[0].count) + 1).padStart(3, '0')}`;
      const total = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;

      const { rows: poRows } = await client.query<{ id: string }>(
        `insert into purchase_orders (firm_id, boq_id, vendor_id, po_number, status, total_amount, gst_amount)
         values (current_firm_id(), $1, $2, $3, 'draft', $4, $5)
         returning id`,
        [boqId, vendorId, poNumber, total, Math.round(total * 0.18 * 100) / 100],
      );
      const poId = poRows[0].id;

      for (const l of lines) {
        await client.query(
          `insert into po_line_items (firm_id, po_id, sku_id, description, uom, quantity, rate, amount)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [poId, l.sku_id, l.description, l.uom, l.quantity, l.rate, l.amount],
        );
      }
      return poNumber;
    });
  }

  /** The materials a vendor currently supplies (latest offer per SKU). */
  fetchVendorSkuLinks(authUid: string, vendorId: string): Promise<VendorSkuLink[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{
        id: string;
        sku_id: string;
        price: string;
        moq: string | null;
        lead_time_days: number;
        sku_code: string;
        brand: string | null;
        product_name: string | null;
        category_id: string | null;
      }>(
        `select vs.id, vs.sku_id, vs.price, vs.moq, vs.lead_time_days,
                ps.sku_code, ps.brand, cp.name as product_name, cp.category_id
           from vendor_skus vs
           join product_skus ps on ps.id = vs.sku_id
           left join catalog_products cp on cp.id = ps.product_id
          where vs.firm_id = current_firm_id() and vs.vendor_id = $1
          order by vs.valid_from desc`,
        [vendorId],
      );
      const cats = await client.query<{ id: string; name: string }>(
        `select id, name from catalog_categories`,
      );
      const catName = new Map(cats.rows.map((c) => [c.id, c.name]));

      const seen = new Set<string>();
      const out: VendorSkuLink[] = [];
      for (const r of rows) {
        if (seen.has(r.sku_id)) continue; // ordered by valid_from desc → first seen is current
        seen.add(r.sku_id);
        out.push({
          id: r.id,
          sku_id: r.sku_id,
          sku_code: r.sku_code ?? '',
          product: r.product_name ?? r.sku_code ?? 'SKU',
          brand: r.brand,
          category: r.category_id ? (catName.get(r.category_id) ?? '—') : '—',
          price: Number(r.price),
          moq: r.moq == null ? null : Number(r.moq),
          lead_time_days: r.lead_time_days,
        });
      }
      return out.sort((a, b) => a.category.localeCompare(b.category) || a.product.localeCompare(b.product));
    });
  }

  /** Every SKU in the catalog — for the "add material" picker. */
  fetchAllSkus(authUid: string): Promise<SkuOption[]> {
    return this.db.withCaller(authUid, async (client) => {
      const skus = await client.query<{
        id: string;
        sku_code: string;
        brand: string | null;
        product_name: string | null;
        category_id: string | null;
      }>(
        `select ps.id, ps.sku_code, ps.brand, cp.name as product_name, cp.category_id
           from product_skus ps
           left join catalog_products cp on cp.id = ps.product_id`,
      );
      const cats = await client.query<{ id: string; name: string; path: string }>(
        `select id, name, path from catalog_categories`,
      );
      const catById = new Map(cats.rows.map((c) => [c.id, { name: c.name, path: c.path }]));
      return skus.rows
        .map((s) => {
          const cat = s.category_id ? catById.get(s.category_id) : undefined;
          return {
            sku_id: s.id,
            sku_code: s.sku_code,
            brand: s.brand,
            product: s.product_name ?? s.sku_code,
            category: cat?.name ?? '—',
            cat_path: cat?.path ?? 'zzz',
          };
        })
        .sort((a, b) => a.cat_path.localeCompare(b.cat_path) || a.product.localeCompare(b.product));
    });
  }

  /** Link a SKU to a vendor (or update today's offer). valid_from defaults
   * to today; unique on (vendor,sku,valid_from). */
  async addVendorSku(
    authUid: string,
    vendorId: string,
    skuId: string,
    input: VendorSkuInput,
  ): Promise<void> {
    await this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from vendor_skus
          where firm_id = current_firm_id() and vendor_id = $1 and sku_id = $2 and valid_from = current_date`,
        [vendorId, skuId],
      );
      if (rows[0]) {
        await client.query(
          `update vendor_skus set price = $1, moq = $2, lead_time_days = $3 where id = $4`,
          [input.price, input.moq, input.lead_time_days, rows[0].id],
        );
      } else {
        await client.query(
          `insert into vendor_skus (firm_id, vendor_id, sku_id, price, moq, lead_time_days)
           values (current_firm_id(), $1, $2, $3, $4, $5)`,
          [vendorId, skuId, input.price, input.moq, input.lead_time_days],
        );
      }
    });
  }

  async updateVendorSku(authUid: string, id: string, input: VendorSkuInput): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(`update vendor_skus set price = $1, moq = $2, lead_time_days = $3 where id = $4`, [
        input.price,
        input.moq,
        input.lead_time_days,
        id,
      ]),
    );
  }

  /** Unlink a SKU from a vendor entirely (removes all dated offers). */
  async removeVendorSku(authUid: string, vendorId: string, skuId: string): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `delete from vendor_skus where firm_id = current_firm_id() and vendor_id = $1 and sku_id = $2`,
        [vendorId, skuId],
      ),
    );
  }
}
