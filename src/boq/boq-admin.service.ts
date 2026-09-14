import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

// ── JSON-friendly mirrors of Vastos_ARC's src/boq/adminApi.ts types ─────────
// Keep field names identical to what that file already returns to its
// callers — this is a drop-in data source, not a reshape.
// Templates/rules admin lives in boq-admin-templates.service.ts instead —
// this file covers catalogue rates, margins and regions.

export interface SkuRow {
  sku_id: string;
  brand: string | null;
  grade: string;
  current_rate: number | null;
}

export interface MaterialRow {
  product_id: string;
  name: string;
  category: string;
  base_uom: string;
  waste_factor: number;
  gst_rate: number;
  skus: SkuRow[];
}

export interface LabourRow {
  activity_id: string;
  code: string;
  name: string;
  base_uom: string;
  trade: string | null;
  current_rate: number | null;
}

export interface MarginRow {
  id: string;
  target_margin_pct: number;
  margin_floor_pct: number;
  overhead_pct: number;
}

export interface ProductSimple {
  id: string;
  name: string;
  base_uom: string;
  category: string;
}

export interface LabourSimple {
  id: string;
  name: string;
  code: string;
  base_uom: string;
  trade: string | null;
}

export interface RegionAdminPatch {
  material_index: number;
  labour_index: number;
  logistics_index: number;
  availability_risk: number;
}

/**
 * Catalogue rates/margins/regions admin (Vastos_ARC's src/boq/adminApi.ts).
 * Split from BoqService (which was already at the project's 500-line file
 * cap) rather than appended to it; templates/rules admin (the other half of
 * adminApi.ts) is in boq-admin-templates.service.ts for the same reason.
 *
 * Audit H2b, unchanged from the frontend original: the catalogue is SHARED.
 * catalog_product_override_set/clear are SECURITY DEFINER RPCs that do their
 * own current_firm_id() + crm_has_permission('catalog','edit') checks and
 * copy-on-write internally — this service proxies to them rather than
 * re-implementing that logic, exactly like supabase-js's `.rpc()` did before.
 */
@Injectable()
export class BoqAdminService {
  constructor(private readonly db: DatabaseService) {}

  fetchMaterialRows(authUid: string): Promise<MaterialRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const cats = await client.query<{ id: string; name: string }>(
        `select id, name from catalog_categories`,
      );
      const products = await client.query<{
        id: string;
        name: string;
        category_id: string;
        base_uom: string;
        waste_factor: string;
        gst_rate: string;
      }>(
        `select id, name, category_id, base_uom, waste_factor, gst_rate
           from catalog_products_effective
          order by name`,
      );
      const skus = await client.query<{
        id: string;
        product_id: string;
        brand: string | null;
        quality_grade: string;
      }>(`select id, product_id, brand, quality_grade from product_skus`);
      const rates = await client.query<{ sku_id: string; rate: string }>(
        `select sku_id, rate
           from rate_cards
          where firm_id = current_firm_id() and region_id is null and sku_id is not null
          order by valid_from desc`,
      );

      const catName = new Map(cats.rows.map((c) => [c.id, c.name]));
      const latest = new Map<string, number>();
      for (const r of rates.rows) {
        if (!latest.has(r.sku_id)) latest.set(r.sku_id, Number(r.rate));
      }
      const byProduct = new Map<string, SkuRow[]>();
      for (const s of skus.rows) {
        const arr = byProduct.get(s.product_id) ?? [];
        arr.push({
          sku_id: s.id,
          brand: s.brand,
          grade: s.quality_grade,
          current_rate: latest.get(s.id) ?? null,
        });
        byProduct.set(s.product_id, arr);
      }

      return products.rows.map((p) => ({
        product_id: p.id,
        name: p.name,
        category: catName.get(p.category_id) ?? '—',
        base_uom: p.base_uom,
        waste_factor: Number(p.waste_factor),
        gst_rate: Number(p.gst_rate),
        skus: byProduct.get(p.id) ?? [],
      }));
    });
  }

  async saveMaterialRate(authUid: string, skuId: string, rate: number): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into rate_cards (firm_id, sku_id, region_id, rate, valid_from, source)
         values (current_firm_id(), $1, null, $2, current_date, 'manual')`,
        [skuId, rate],
      ),
    );
  }

  /** Copy-on-write (H2b): the RPC updates in place for this firm's own
   * product, or writes a sparse per-firm override for a shared global one —
   * the caller doesn't need to know which. */
  async saveProductWaste(authUid: string, productId: string, waste: number): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(`select catalog_product_override_set($1, $2::jsonb)`, [
        productId,
        JSON.stringify({ waste_factor: waste }),
      ]),
    );
  }

  async clearProductOverride(authUid: string, productId: string): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(`select catalog_product_override_clear($1)`, [productId]),
    );
  }

  fetchLabourRows(authUid: string): Promise<LabourRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const acts = await client.query<{
        id: string;
        code: string;
        name: string;
        base_uom: string;
        trade: string | null;
      }>(`select id, code, name, base_uom, trade from labour_activities order by trade`);
      const rates = await client.query<{ labour_activity_id: string; rate: string }>(
        `select labour_activity_id, rate
           from rate_cards
          where firm_id = current_firm_id() and region_id is null and labour_activity_id is not null
          order by valid_from desc`,
      );
      const latest = new Map<string, number>();
      for (const r of rates.rows) {
        if (!latest.has(r.labour_activity_id)) latest.set(r.labour_activity_id, Number(r.rate));
      }
      return acts.rows.map((a) => ({
        activity_id: a.id,
        code: a.code,
        name: a.name,
        base_uom: a.base_uom,
        trade: a.trade,
        current_rate: latest.get(a.id) ?? null,
      }));
    });
  }

  async saveLabourRate(authUid: string, activityId: string, rate: number): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into rate_cards (firm_id, labour_activity_id, region_id, rate, valid_from, source)
         values (current_firm_id(), $1, null, $2, current_date, 'manual')`,
        [activityId, rate],
      ),
    );
  }

  fetchMargin(authUid: string): Promise<MarginRow | null> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{
        id: string;
        target_margin_pct: string;
        margin_floor_pct: string;
        overhead_pct: string;
      }>(
        `select id, target_margin_pct, margin_floor_pct, overhead_pct
           from margin_policies
          where firm_id = current_firm_id() and category_id is null and grade is null
          limit 1`,
      );
      const m = rows[0];
      return m
        ? {
            id: m.id,
            target_margin_pct: Number(m.target_margin_pct),
            margin_floor_pct: Number(m.margin_floor_pct),
            overhead_pct: Number(m.overhead_pct),
          }
        : null;
    });
  }

  async saveMargin(
    authUid: string,
    id: string,
    m: { target_margin_pct: number; margin_floor_pct: number; overhead_pct: number },
  ): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `update margin_policies
            set target_margin_pct = $1, margin_floor_pct = $2, overhead_pct = $3
          where id = $4`,
        [m.target_margin_pct, m.margin_floor_pct, m.overhead_pct, id],
      ),
    );
  }

  /** Fetch the firm-wide default margin policy, creating a sensible default
   * if none exists yet (self-heals after a data reset) — read and
   * conditional insert now happen inside one transaction instead of two
   * round trips. */
  ensureMargin(authUid: string): Promise<MarginRow> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{
        id: string;
        target_margin_pct: string;
        margin_floor_pct: string;
        overhead_pct: string;
      }>(
        `select id, target_margin_pct, margin_floor_pct, overhead_pct
           from margin_policies
          where firm_id = current_firm_id() and category_id is null and grade is null
          limit 1`,
      );
      const existing = rows[0];
      if (existing) {
        return {
          id: existing.id,
          target_margin_pct: Number(existing.target_margin_pct),
          margin_floor_pct: Number(existing.margin_floor_pct),
          overhead_pct: Number(existing.overhead_pct),
        };
      }
      const { rows: created } = await client.query<{
        id: string;
        target_margin_pct: string;
        margin_floor_pct: string;
        overhead_pct: string;
      }>(
        `insert into margin_policies (firm_id, category_id, grade, target_margin_pct, margin_floor_pct, overhead_pct)
         values (current_firm_id(), null, null, 35, 18, 8)
         returning id, target_margin_pct, margin_floor_pct, overhead_pct`,
      );
      const m = created[0];
      return {
        id: m.id,
        target_margin_pct: Number(m.target_margin_pct),
        margin_floor_pct: Number(m.margin_floor_pct),
        overhead_pct: Number(m.overhead_pct),
      };
    });
  }

  /** GET is served by the existing BoqService.fetchRegions() — identical
   * query, no need for a second read endpoint. This is the write half that
   * regions never had before (the estimator only ever read them). */
  async saveRegion(authUid: string, id: string, r: RegionAdminPatch): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `update regions
            set material_index = $1, labour_index = $2, logistics_index = $3, availability_risk = $4
          where id = $5`,
        [r.material_index, r.labour_index, r.logistics_index, r.availability_risk, id],
      ),
    );
  }

  fetchProductsSimple(authUid: string): Promise<ProductSimple[]> {
    return this.db.withCaller(authUid, async (client) => {
      const cats = await client.query<{ id: string; name: string }>(
        `select id, name from catalog_categories`,
      );
      const prods = await client.query<{
        id: string;
        name: string;
        base_uom: string;
        category_id: string;
      }>(
        `select id, name, base_uom, category_id
           from catalog_products_effective
          where is_active = true
          order by name`,
      );
      const catName = new Map(cats.rows.map((c) => [c.id, c.name]));
      return prods.rows.map((p) => ({
        id: p.id,
        name: p.name,
        base_uom: p.base_uom,
        category: catName.get(p.category_id) ?? '',
      }));
    });
  }

  fetchLabourSimple(authUid: string): Promise<LabourSimple[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<LabourSimple>(
        `select id, name, code, base_uom, trade from labour_activities order by name`,
      );
      return rows;
    });
  }
}
