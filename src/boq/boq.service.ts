import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import {
  computeCalibration,
  overallAccuracy,
  type Calibration,
  type VarianceRow,
} from './calibration-engine';

// ── JSON-friendly mirrors of the frontend's src/boq/engine/estimator.ts types ─
// The frontend reconstructs Maps from these plain arrays/objects — see
// Vastos_ARC's src/boq/api.ts. Keep field names identical to what that engine
// already consumes; this is a drop-in data source, not a reshape.
export interface RegionRow {
  id: string;
  name: string;
  material_index: number;
  labour_index: number;
  logistics_index: number;
  availability_risk: number;
}

export interface RuleRow {
  id: string;
  template_id: string;
  seq: number;
  output_kind: string;
  product_id: string | null;
  labour_activity_id: string | null;
  label: string;
  condition: string | null;
  qty_formula: string;
  uom: string;
}

export interface TemplateRow {
  id: string;
  code: string;
  name: string;
  category: string;
  param_schema: Record<string, unknown>;
  derived_vars: unknown[];
  rules: RuleRow[];
}

export interface PricingContextPayload {
  region: {
    material_index: number;
    labour_index: number;
    logistics_index: number;
    availability_risk: number;
  };
  margin: {
    target_margin_pct: number;
    margin_floor_pct: number;
    overhead_pct: number;
  };
  products: Array<{
    id: string;
    name: string;
    base_uom: string;
    waste_factor: number;
    packaging_loss: number;
    install_loss: number;
    gst_rate: number;
  }>;
  materialRates: Array<{
    product_id: string;
    sku_id: string;
    brand: string | null;
    grade: string;
    rate: number;
  }>;
  labourRates: Array<{ labour_activity_id: string; rate: number }>;
  labourNames: Array<{ id: string; name: string }>;
}

export interface BoqListRow {
  id: string;
  title: string;
  status: string;
  grand_total: string;
  total_cost_price: string;
  margin_pct: string | null;
  created_at: string;
}

interface RegionIndicesRow {
  material_index: string;
  labour_index: string;
  logistics_index: string;
  availability_risk: string;
}

export interface BoqDetailLinePayload {
  id: string;
  description: string;
  uom: string;
  quantity: number;
  rate: number;
  cost_price: number;
  selling_price: number;
  margin_pct: number | null;
  gst_rate: number;
  product_id: string | null;
  sku_id: string | null;
  labour_activity_id: string | null;
  is_optional: boolean;
}

export interface BoqDetailPayload {
  id: string;
  title: string;
  status: string;
  region_id: string | null;
  sections: Array<{ id: string; name: string; lines: BoqDetailLinePayload[] }>;
}

export interface SaveQuotationInput {
  boqId: string;
  boqVersion?: number;
  docType: 'customer' | 'internal_costing' | 'procurement' | 'vendor_rfq';
  design_fees?: number;
  supervision_fees?: number;
  other_charges?: number;
  discount_pct?: number;
  subtotal: number;
  gst_amount: number;
  total_amount: number;
  snapshot: unknown;
}

export interface SavedQuotation {
  id: string;
  quotation_number: string;
  share_token: string;
}

export interface QuotationListRow {
  id: string;
  quotation_number: string;
  doc_type: string;
  total_amount: string;
  status: string;
  created_at: string;
  boq_id: string | null;
}

// ── Calibration payload types (mirror src/boq/calibrationApi.ts exactly —
// these are consumed with zero reshaping on the frontend, same as bootstrap
// and pricing-context). ────────────────────────────────────────────────────
type VarianceRowPayload = VarianceRow;

export interface ProductVarianceRow {
  product_id: string;
  name: string;
  base_uom: string;
  waste_factor: number;
  standard_sku_id: string | null;
  current_rate: number | null;
  sample_size: number;
  calib: Calibration | null;
}

export interface VarianceSummaryPayload {
  products: ProductVarianceRow[];
  accuracy: number;
  total_samples: number;
  projects: number;
}

export interface CalibrationResultRow {
  product: string;
  waste_old: number;
  waste_new: number;
  rate_old: number | null;
  rate_new: number | null;
}

export interface CalibrationHistoryRow {
  metric: string;
  old_value: number;
  new_value: number;
  sample_size: number;
  run_at: string;
  product: string;
}

function numOrNull(v: string | null): number | null {
  return v == null ? null : Number(v);
}

export interface SaveBoqInput {
  title: string;
  regionId: string | null;
  sections: Array<{ name: string; lines: Record<string, unknown>[] }>;
  totals: {
    cost_price: number;
    selling_price: number;
    gst: number;
    grand_total: number;
    margin_pct: number;
  };
}

@Injectable()
export class BoqService {
  constructor(private readonly db: DatabaseService) {}

  fetchRegions(authUid: string): Promise<RegionRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<RegionRow>(
        `select id, name, material_index, labour_index, logistics_index, availability_risk
           from regions
          where firm_id = current_firm_id()
          order by name`,
      );
      return rows;
    });
  }

  fetchTemplates(authUid: string): Promise<TemplateRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      // No explicit firm filter — RLS already includes this firm's own
      // templates plus the shared (firm_id is null) catalogue, same as the
      // frontend's unfiltered original query. Sequential (see the comment in
      // fetchPricingContext) rather than Promise.all on one client.
      const { rows: tpls } = await client.query<{
        id: string;
        code: string;
        name: string;
        category: string;
        param_schema: Record<string, unknown> | null;
        derived_vars: unknown;
      }>(
        `select id, code, name, category, param_schema, derived_vars
           from module_templates
          where is_active = true
          order by name`,
      );
      const { rows: rules } = await client.query<RuleRow>(
        `select id, template_id, seq, output_kind, product_id, labour_activity_id,
                label, condition, qty_formula, uom
           from module_rules`,
      );

      const byTemplate = new Map<string, RuleRow[]>();
      for (const r of rules) {
        const arr = byTemplate.get(r.template_id) ?? [];
        arr.push(r);
        byTemplate.set(r.template_id, arr);
      }

      return tpls.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        category: t.category,
        param_schema: t.param_schema ?? {},
        derived_vars: Array.isArray(t.derived_vars) ? t.derived_vars : [],
        rules: byTemplate.get(t.id) ?? [],
      }));
    });
  }

  fetchPricingContext(
    authUid: string,
    regionId: string | null,
  ): Promise<PricingContextPayload> {
    return this.db.withCaller(authUid, async (client) => {
      // Sequential, not Promise.all: node-postgres runs one query at a time
      // per client anyway (queued under the hood), and awaiting each in turn
      // avoids its "query already in progress" deprecation warning.
      //
      // Audit H2b: the effective view resolves this firm's catalogue
      // overrides over the shared global rows, keeping the global row's id so
      // product_id references stay valid.
      const products = await client.query<{
        id: string;
        name: string;
        base_uom: string;
        waste_factor: string;
        packaging_loss: string;
        install_loss: string;
        gst_rate: string;
      }>(
        `select id, name, base_uom, waste_factor, packaging_loss, install_loss, gst_rate
           from catalog_products_effective`,
      );
      const skus = await client.query<{
        id: string;
        product_id: string;
        brand: string | null;
        quality_grade: string;
      }>(`select id, product_id, brand, quality_grade from product_skus`);
      const matRates = await client.query<{
        sku_id: string;
        rate: string;
        region_id: string | null;
      }>(
        `select sku_id, rate, region_id
           from rate_cards
          where firm_id = current_firm_id() and sku_id is not null`,
      );
      const labour = await client.query<{
        id: string;
        code: string;
        name: string;
      }>(`select id, code, name from labour_activities`);
      const labRates = await client.query<{
        labour_activity_id: string;
        rate: string;
        region_id: string | null;
      }>(
        `select labour_activity_id, rate, region_id
           from rate_cards
          where firm_id = current_firm_id() and labour_activity_id is not null`,
      );
      const margin = await client.query<{
        target_margin_pct: string;
        margin_floor_pct: string;
        overhead_pct: string;
      }>(
        `select target_margin_pct, margin_floor_pct, overhead_pct
           from margin_policies
          where firm_id = current_firm_id() and category_id is null and grade is null
          limit 1`,
      );
      const region = regionId
        ? await client.query<RegionIndicesRow>(
            `select material_index, labour_index, logistics_index, availability_risk
               from regions
              where id = $1
              limit 1`,
            [regionId],
          )
        : { rows: [] as RegionIndicesRow[] };

      const skuMeta = new Map<
        string,
        { product_id: string; brand: string | null; quality_grade: string }
      >();
      for (const s of skus.rows) skuMeta.set(s.id, s);

      const materialRates = matRates.rows
        .filter((r) => !r.region_id) // engine applies the region index itself; use national base
        .map((r) => {
          const meta = skuMeta.get(r.sku_id);
          return meta
            ? {
                product_id: meta.product_id,
                sku_id: r.sku_id,
                brand: meta.brand,
                grade: meta.quality_grade,
                rate: Number(r.rate),
              }
            : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const labourRates = labRates.rows
        .filter((r) => !r.region_id)
        .map((r) => ({
          labour_activity_id: r.labour_activity_id,
          rate: Number(r.rate),
        }));

      const m = margin.rows[0];
      const rg = region.rows[0];

      return {
        region: rg
          ? {
              material_index: Number(rg.material_index),
              labour_index: Number(rg.labour_index),
              logistics_index: Number(rg.logistics_index),
              availability_risk: Number(rg.availability_risk),
            }
          : {
              material_index: 1,
              labour_index: 1,
              logistics_index: 1,
              availability_risk: 0,
            },
        margin: m
          ? {
              target_margin_pct: Number(m.target_margin_pct),
              margin_floor_pct: Number(m.margin_floor_pct),
              overhead_pct: Number(m.overhead_pct),
            }
          : { target_margin_pct: 35, margin_floor_pct: 18, overhead_pct: 8 },
        products: products.rows.map((p) => ({
          id: p.id,
          name: p.name,
          base_uom: p.base_uom,
          waste_factor: Number(p.waste_factor),
          packaging_loss: Number(p.packaging_loss),
          install_loss: Number(p.install_loss),
          gst_rate: Number(p.gst_rate),
        })),
        materialRates,
        labourRates,
        labourNames: labour.rows.map((l) => ({ id: l.id, name: l.name })),
      };
    });
  }

  listBoqs(authUid: string): Promise<BoqListRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<BoqListRow>(
        `select id, title, status, grand_total, total_cost_price, margin_pct, created_at
           from boq_documents
          where firm_id = current_firm_id()
          order by created_at desc`,
      );
      return rows;
    });
  }

  /**
   * boq_documents → boq_sections → boq_line_items → boq_revisions, all in one
   * withCaller() transaction — a real correctness improvement over the
   * frontend's original sequential inserts, which had no rollback: a failure
   * partway left an orphaned boq_documents row with no sections.
   *
   * firm_id comes from current_firm_id(), not the client — the frontend used
   * to pass firmId itself (defence-in-depth against a forged value, same as
   * every other migrated write); here there's nothing to forge.
   */
  saveBoq(authUid: string, input: SaveBoqInput): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const boqId = await this.insertDocument(client, input);
      for (let i = 0; i < input.sections.length; i++) {
        await this.insertSection(client, boqId, input.sections[i], i);
      }
      await this.insertRevision(client, boqId, input);
      return boqId;
    });
  }

  private async insertDocument(
    client: PoolClient,
    input: SaveBoqInput,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into boq_documents
         (firm_id, title, status, region_id,
          total_cost_price, total_selling_price, total_gst, grand_total, margin_pct)
       values
         (current_firm_id(), $1, 'draft', $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        input.title,
        input.regionId,
        input.totals.cost_price,
        input.totals.selling_price,
        input.totals.gst,
        input.totals.grand_total,
        input.totals.margin_pct,
      ],
    );
    return rows[0].id;
  }

  private async insertSection(
    client: PoolClient,
    boqId: string,
    section: SaveBoqInput['sections'][number],
    orderIndex: number,
  ): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      `insert into boq_sections (firm_id, boq_id, name, order_index)
       values (current_firm_id(), $1, $2, $3)
       returning id`,
      [boqId, section.name, orderIndex],
    );
    const sectionId = rows[0].id;

    for (let idx = 0; idx < section.lines.length; idx++) {
      const l = section.lines[idx] as Record<string, any>;
      await client.query(
        `insert into boq_line_items
           (firm_id, boq_id, section_id, product_id, sku_id, labour_activity_id,
            description, uom, quantity, rate, cost_price, selling_price, margin_pct,
            gst_rate, derivation, source, is_optional, order_index)
         values
           (current_firm_id(), $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17)`,
        [
          boqId,
          sectionId,
          l.product_id ?? null,
          l.sku_id ?? null,
          l.labour_activity_id ?? null,
          l.description,
          l.uom,
          l.quantity,
          l.rate,
          l.cost_price,
          l.selling_price,
          l.margin_pct ?? null,
          l.gst_rate,
          l.derivation ? JSON.stringify(l.derivation) : null,
          l.source ?? 'engine',
          l.is_optional ?? false,
          idx,
        ],
      );
    }
  }

  private async insertRevision(
    client: PoolClient,
    boqId: string,
    input: SaveBoqInput,
  ): Promise<void> {
    await client.query(
      `insert into boq_revisions (firm_id, boq_id, version, snapshot, totals, reason)
       values (current_firm_id(), $1, 1, $2, $3, 'Initial generation')`,
      [boqId, JSON.stringify(input.sections), JSON.stringify(input.totals)],
    );
  }

  // ── Quotations (src/boq/quotationApi.ts) ──────────────────────────────────
  // The public/unauthenticated share-and-accept flow (quote_public_view /
  // accept_quote, called by anon via share_token — no login at all) is NOT
  // covered here; it's a different auth model from everything else in this
  // service (no bearer token, no current_firm_id()) and stays on
  // supabase-js/PostgREST for now. See Vastos_ARC's quoteShareApi.ts.

  async fetchBoqDetail(
    authUid: string,
    boqId: string,
  ): Promise<BoqDetailPayload> {
    return this.db.withCaller(authUid, async (client) => {
      const doc = await client.query<{
        id: string;
        title: string;
        status: string;
        region_id: string | null;
      }>(
        `select id, title, status, region_id from boq_documents where id = $1 limit 1`,
        [boqId],
      );
      const row = doc.rows[0];
      if (!row) throw new NotFoundException(`boq_documents/${boqId} not found`);

      const sections = await client.query<{
        id: string;
        name: string;
        order_index: number;
      }>(
        `select id, name, order_index from boq_sections where boq_id = $1 order by order_index`,
        [boqId],
      );
      const lines = await client.query<{
        id: string;
        section_id: string;
        description: string;
        uom: string;
        quantity: string;
        rate: string;
        cost_price: string;
        selling_price: string;
        margin_pct: string | null;
        gst_rate: string;
        product_id: string | null;
        sku_id: string | null;
        labour_activity_id: string | null;
        is_optional: boolean;
      }>(
        `select id, section_id, description, uom, quantity, rate, cost_price, selling_price,
                margin_pct, gst_rate, product_id, sku_id, labour_activity_id, is_optional
           from boq_line_items
          where boq_id = $1
          order by order_index`,
        [boqId],
      );

      const bySection = new Map<
        string,
        BoqDetailPayload['sections'][number]['lines']
      >();
      for (const l of lines.rows) {
        const arr = bySection.get(l.section_id) ?? [];
        arr.push({
          id: l.id,
          description: l.description,
          uom: l.uom,
          quantity: Number(l.quantity),
          rate: Number(l.rate),
          cost_price: Number(l.cost_price),
          selling_price: Number(l.selling_price),
          margin_pct: l.margin_pct == null ? null : Number(l.margin_pct),
          gst_rate: Number(l.gst_rate),
          product_id: l.product_id,
          sku_id: l.sku_id,
          labour_activity_id: l.labour_activity_id,
          is_optional: l.is_optional,
        });
        bySection.set(l.section_id, arr);
      }

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        region_id: row.region_id,
        sections: sections.rows.map((s) => ({
          id: s.id,
          name: s.name,
          lines: bySection.get(s.id) ?? [],
        })),
      };
    });
  }

  async saveQuotation(
    authUid: string,
    input: SaveQuotationInput,
  ): Promise<SavedQuotation> {
    return this.db.withCaller(authUid, async (client) => {
      // Same numbering scheme as before (QT-<year>-<count+1>), but now
      // computed and inserted in the same transaction — the old code did the
      // count and the insert as two separate round trips.
      const { rows: countRows } = await client.query<{ count: string }>(
        `select count(*) from quotations where firm_id = current_firm_id()`,
      );
      const year = new Date().getFullYear();
      const number = `QT-${year}-${String(Number(countRows[0].count) + 1).padStart(3, '0')}`;

      const { rows } = await client.query<SavedQuotation>(
        `insert into quotations
           (firm_id, boq_id, boq_version, doc_type, quotation_number, version,
            design_fees, supervision_fees, other_charges, discount_pct,
            subtotal, gst_amount, total_amount, status, snapshot)
         values
           (current_firm_id(), $1, $2, $3, $4, 1,
            $5, $6, $7, $8,
            $9, $10, $11, 'draft', $12)
         returning id, quotation_number, share_token`,
        [
          input.boqId,
          input.boqVersion ?? 1,
          input.docType,
          number,
          input.design_fees ?? 0,
          input.supervision_fees ?? 0,
          input.other_charges ?? 0,
          input.discount_pct ?? 0,
          input.subtotal,
          input.gst_amount,
          input.total_amount,
          JSON.stringify(input.snapshot),
        ],
      );
      return rows[0];
    });
  }

  listQuotations(authUid: string): Promise<QuotationListRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<QuotationListRow>(
        `select id, quotation_number, doc_type, total_amount, status, created_at, boq_id
           from quotations
          where firm_id = current_firm_id()
          order by created_at desc`,
      );
      return rows;
    });
  }

  // ── Calibration (src/boq/calibrationApi.ts) ───────────────────────────────

  fetchVarianceSummary(authUid: string): Promise<VarianceSummaryPayload> {
    return this.db.withCaller(authUid, (client) =>
      this.varianceSummary(client),
    );
  }

  private async varianceSummary(
    client: PoolClient,
  ): Promise<VarianceSummaryPayload> {
    const variance = await client.query<{
      product_id: string;
      project_id: string | null;
      estimated_qty: string | null;
      actual_qty: string | null;
      estimated_rate: string | null;
      actual_rate: string | null;
      estimated_cost: string | null;
      actual_cost: string | null;
    }>(
      `select product_id, project_id, estimated_qty, actual_qty, estimated_rate,
              actual_rate, estimated_cost, actual_cost
         from boq_actual_variance
        where firm_id = current_firm_id()`,
    );
    const products = await client.query<{
      id: string;
      name: string;
      base_uom: string;
      waste_factor: string;
    }>(
      `select id, name, base_uom, waste_factor from catalog_products_effective`,
    );
    const skus = await client.query<{
      id: string;
      product_id: string;
      quality_grade: string;
    }>(`select id, product_id, quality_grade from product_skus`);
    const rates = await client.query<{ sku_id: string; rate: string }>(
      `select sku_id, rate
         from rate_cards
        where firm_id = current_firm_id() and region_id is null and sku_id is not null
        order by valid_from desc`,
    );

    const prodMeta = new Map(products.rows.map((p) => [p.id, p]));
    const stdSku = new Map<string, string>();
    for (const s of skus.rows) {
      if (s.quality_grade === 'standard' && !stdSku.has(s.product_id)) {
        stdSku.set(s.product_id, s.id);
      }
    }
    const latestRate = new Map<string, number>();
    for (const r of rates.rows) {
      if (!latestRate.has(r.sku_id)) latestRate.set(r.sku_id, Number(r.rate));
    }

    const byProduct = new Map<string, VarianceRowPayload[]>();
    const projectIds = new Set<string>();
    for (const v of variance.rows) {
      if (v.project_id) projectIds.add(v.project_id);
      const arr = byProduct.get(v.product_id) ?? [];
      arr.push({
        estimated_qty: numOrNull(v.estimated_qty),
        actual_qty: numOrNull(v.actual_qty),
        estimated_rate: numOrNull(v.estimated_rate),
        actual_rate: numOrNull(v.actual_rate),
        estimated_cost: numOrNull(v.estimated_cost),
        actual_cost: numOrNull(v.actual_cost),
      });
      byProduct.set(v.product_id, arr);
    }

    const out: ProductVarianceRow[] = [];
    const allRows: VarianceRowPayload[] = [];
    for (const [pid, rows] of byProduct) {
      const meta = prodMeta.get(pid);
      if (!meta) continue;
      allRows.push(...rows);
      const wasteFactor = Number(meta.waste_factor);
      const sku = stdSku.get(pid) ?? null;
      out.push({
        product_id: pid,
        name: meta.name,
        base_uom: meta.base_uom,
        waste_factor: wasteFactor,
        standard_sku_id: sku,
        current_rate: sku ? (latestRate.get(sku) ?? null) : null,
        sample_size: rows.length,
        calib: computeCalibration(rows, wasteFactor),
      });
    }
    out.sort(
      (a, b) =>
        Math.abs(b.calib?.mean_variance_pct ?? 0) -
        Math.abs(a.calib?.mean_variance_pct ?? 0),
    );

    return {
      products: out,
      accuracy: overallAccuracy(allRows),
      total_samples: allRows.length,
      projects: projectIds.size,
    };
  }

  async runCalibration(
    authUid: string,
    regionId: string | null,
  ): Promise<CalibrationResultRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      // createdBy resolved from the verified session, not a client-supplied
      // value — same principle as current_firm_id() everywhere else here.
      const { rows: meRows } = await client.query<{ id: string }>(
        `select id from profiles where auth_uid = $1 limit 1`,
        [authUid],
      );
      const createdBy = meRows[0]?.id ?? null;

      const summary = await this.varianceSummary(client);
      const results: CalibrationResultRow[] = [];
      const today = new Date().toISOString().slice(0, 10);

      for (const p of summary.products) {
        const calib = p.calib;
        if (!calib || calib.sample_size < 3) continue;

        const wasteChanged =
          Math.abs(calib.waste_new - calib.waste_old) > 0.0005;
        const rateNew =
          p.current_rate != null
            ? Math.round(p.current_rate * calib.rate_multiplier * 100) / 100
            : null;
        const rateChanged =
          rateNew != null && Math.abs(rateNew - (p.current_rate ?? 0)) > 0.01;
        if (!wasteChanged && !rateChanged) continue;

        if (wasteChanged) {
          // H2b: calibration is per-firm by definition, so this writes a
          // per-firm override rather than the shared catalogue row every
          // other firm prices from — same RPC the frontend called directly.
          await client.query(
            `select catalog_product_override_set($1, $2::jsonb)`,
            [p.product_id, JSON.stringify({ waste_factor: calib.waste_new })],
          );
          await client.query(
            `insert into calibration_runs
               (firm_id, product_id, region_id, metric, old_value, new_value, sample_size, damping)
             values (current_firm_id(), $1, $2, 'waste_factor', $3, $4, $5, 0.3)`,
            [
              p.product_id,
              regionId,
              calib.waste_old,
              calib.waste_new,
              calib.sample_size,
            ],
          );
        }
        if (rateChanged && p.standard_sku_id) {
          await client.query(
            `insert into rate_cards
               (firm_id, sku_id, region_id, rate, valid_from, source, created_by)
             values (current_firm_id(), $1, $2, $3, $4, 'calibrated', $5)`,
            [p.standard_sku_id, regionId, rateNew, today, createdBy],
          );
          await client.query(
            `insert into calibration_runs
               (firm_id, product_id, region_id, metric, old_value, new_value, sample_size, damping)
             values (current_firm_id(), $1, $2, 'rate_index', $3, $4, $5, 0.3)`,
            [
              p.product_id,
              regionId,
              p.current_rate,
              rateNew,
              calib.sample_size,
            ],
          );
        }
        results.push({
          product: p.name,
          waste_old: calib.waste_old,
          waste_new: calib.waste_new,
          rate_old: p.current_rate,
          rate_new: rateChanged ? rateNew : p.current_rate,
        });
      }
      return results;
    });
  }

  fetchCalibrationHistory(authUid: string): Promise<CalibrationHistoryRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{
        metric: string;
        old_value: string;
        new_value: string;
        sample_size: number;
        run_at: string;
        product_name: string | null;
      }>(
        `select cr.metric, cr.old_value, cr.new_value, cr.sample_size, cr.run_at,
                cp.name as product_name
           from calibration_runs cr
           left join catalog_products cp on cp.id = cr.product_id
          where cr.firm_id = current_firm_id()
          order by cr.run_at desc
          limit 40`,
      );
      return rows.map((r) => ({
        metric: r.metric,
        old_value: Number(r.old_value),
        new_value: Number(r.new_value),
        sample_size: r.sample_size,
        run_at: r.run_at,
        product: r.product_name ?? '—',
      }));
    });
  }

  /** Reconcile a completed BOQ: write estimated-vs-actual rows. For the demo,
   * if no actuals exist yet, synthesize plausible ones from the BOQ's own
   * lines first (mirrors the frontend's original dev/demo synthesizer). */
  async reconcileBoqFromActuals(
    authUid: string,
    boqId: string,
    regionId: string | null,
  ): Promise<number> {
    const detail = await this.fetchBoqDetail(authUid, boqId);
    const matLines = detail.sections
      .flatMap((s) => s.lines)
      .filter((l) => l.product_id && !l.labour_activity_id);
    if (matLines.length === 0) return 0;

    return this.db.withCaller(authUid, async (client) => {
      let inserted = 0;
      for (const l of matLines) {
        const drift = 1 + (Math.random() * 0.18 - 0.04); // -4%..+14%
        const actualQty = Math.round(l.quantity * drift * 1000) / 1000;
        const actualRate =
          Math.round(l.rate * (1 + (Math.random() * 0.06 - 0.02)) * 100) / 100;
        const actualCost = Math.round(actualQty * actualRate * 100) / 100;
        // PRE-EXISTING BUG, ported unchanged: boq_actual_variance.project_id is
        // NOT NULL with no default, and neither this function nor saveBoq ever
        // had a real project id to supply — the frontend always sent `null`
        // too, so this insert has presumably always thrown here. Not fixing
        // silently: the right fix (thread a real project_id through
        // BoqEstimatorPage -> saveBoq -> boq_documents.project_id -> here, or
        // add a projectId param to this endpoint) is a product decision, not
        // a migration detail. Flagged to the user.
        await client.query(
          `insert into boq_actual_variance
             (firm_id, boq_line_id, project_id, region_id, product_id,
              estimated_qty, actual_qty, estimated_rate, actual_rate, estimated_cost, actual_cost)
           values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            l.id,
            null,
            regionId,
            l.product_id,
            l.quantity,
            actualQty,
            l.rate,
            actualRate,
            l.cost_price,
            actualCost,
          ],
        );
        inserted++;
      }
      return inserted;
    });
  }
}
