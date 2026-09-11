import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';

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
}
