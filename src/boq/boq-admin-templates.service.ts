import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

// ── JSON-friendly mirrors of Vastos_ARC's src/boq/adminApi.ts types ─────────
// Templates/rules half of adminApi.ts — catalogue rates/margins/regions are
// in boq-admin.service.ts instead (split to stay under the 500-line cap).

export interface RuleAdminRow {
  id: string;
  template_id: string;
  seq: number;
  label: string;
  output_kind: 'material' | 'labour' | 'hardware' | 'service';
  product_id: string | null;
  labour_activity_id: string | null;
  qty_formula: string;
  condition: string | null;
  uom: string;
}

export interface TemplateAdminRow {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  param_schema: Record<string, unknown>;
  derived_vars: Array<{ name: string; formula: string }>;
  is_active: boolean;
  rules: RuleAdminRow[];
}

export interface TemplateMetaPatch {
  name: string;
  description: string;
  category: string;
  derived_vars: unknown[];
  param_schema: unknown;
}

export interface CreateTemplateInput {
  code: string;
  name: string;
  category: string;
  description: string;
  param_schema: unknown;
  derived_vars: unknown[];
}

/**
 * Templates/rules admin (Vastos_ARC's src/boq/adminApi.ts). Every write here
 * proxies to a SECURITY DEFINER RPC (module_template_set_meta,
 * module_rule_save, module_rule_delete) that does its own
 * current_firm_id() + crm_has_permission('catalog','edit') check and
 * fork-on-write (H2b: editing a shared global template forks it into this
 * firm first) — this service doesn't re-implement any of that.
 */
@Injectable()
export class BoqAdminTemplatesService {
  constructor(private readonly db: DatabaseService) {}

  fetchTemplatesAdmin(authUid: string): Promise<TemplateAdminRow[]> {
    return this.db.withCaller(authUid, async (client) => {
      // Unfiltered module_rules query, same as the frontend original: RLS
      // scopes visible rows to this firm's own templates plus every global
      // one. A forked global template's pre-fork rules stay in the result
      // set (rows keyed by the original template_id) but are simply never
      // looked up below, since module_templates_effective hides that id —
      // harmless, and exactly what the original frontend code did too.
      const tpls = await client.query<{
        id: string;
        code: string;
        name: string;
        category: string;
        description: string | null;
        param_schema: Record<string, unknown> | null;
        derived_vars: unknown;
        is_active: boolean;
      }>(
        `select id, code, name, category, description, param_schema, derived_vars, is_active
           from module_templates_effective
          order by name`,
      );
      const rules = await client.query<RuleAdminRow>(
        `select id, template_id, seq, output_kind, product_id, labour_activity_id,
                label, condition, qty_formula, uom
           from module_rules
          order by seq`,
      );

      const byTpl = new Map<string, RuleAdminRow[]>();
      for (const r of rules.rows) {
        const arr = byTpl.get(r.template_id) ?? [];
        arr.push(r);
        byTpl.set(r.template_id, arr);
      }

      return tpls.rows.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        category: t.category,
        description: t.description,
        param_schema: t.param_schema ?? {},
        derived_vars: Array.isArray(t.derived_vars) ? (t.derived_vars as any) : [],
        is_active: t.is_active,
        rules: byTpl.get(t.id) ?? [],
      }));
    });
  }

  /** Fork-on-write (H2b): editing a shared global template forks it into
   * this firm first, so the template id returned may differ from `id`. */
  updateTemplateActive(authUid: string, id: string, isActive: boolean): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ tpl_id: string }>(
        `select module_template_set_meta($1, $2::jsonb) as tpl_id`,
        [id, JSON.stringify({ is_active: isActive })],
      );
      return rows[0].tpl_id;
    });
  }

  saveTemplateMeta(authUid: string, id: string, data: TemplateMetaPatch): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ tpl_id: string }>(
        `select module_template_set_meta($1, $2::jsonb) as tpl_id`,
        [id, JSON.stringify(data)],
      );
      return rows[0].tpl_id;
    });
  }

  createTemplateFull(authUid: string, data: CreateTemplateInput): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into module_templates (firm_id, code, name, category, description, param_schema, derived_vars, is_active)
         values (current_firm_id(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, true)
         returning id`,
        [
          data.code,
          data.name,
          data.category,
          data.description,
          JSON.stringify(data.param_schema),
          JSON.stringify(data.derived_vars),
        ],
      );
      return rows[0].id;
    });
  }

  /** Rules inherit their template's tenancy (H2b), so module_rule_save forks
   * the parent template first when it's a shared global one. */
  saveRule(
    authUid: string,
    rule: Omit<RuleAdminRow, 'id'>,
  ): Promise<{ template_id: string; rule_id: string }> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: { template_id: string; rule_id: string } }>(
        `select module_rule_save(null, $1, $2::jsonb) as result`,
        [rule.template_id, JSON.stringify(rule)],
      );
      return rows[0].result;
    });
  }

  updateRule(
    authUid: string,
    id: string,
    data: Partial<Omit<RuleAdminRow, 'id'>>,
  ): Promise<{ template_id: string; rule_id: string }> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: { template_id: string; rule_id: string } }>(
        `select module_rule_save($1, $2, $3::jsonb) as result`,
        [id, data.template_id ?? null, JSON.stringify(data)],
      );
      return rows[0].result;
    });
  }

  deleteRule(authUid: string, id: string): Promise<{ template_id: string }> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ result: { template_id: string } }>(
        `select module_rule_delete($1) as result`,
        [id],
      );
      return rows[0].result;
    });
  }
}
