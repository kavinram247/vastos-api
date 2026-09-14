import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import { computeVendorScore, type PerfRow, type VendorScore } from './vendor-score-engine';

// ── JSON-friendly mirrors of Vastos_ARC's src/boq/vendorApi.ts types ────────
// Core vendor + scoring + directory. SKU-linking/candidates/PO generation is
// in boq-vendor-sku.service.ts instead (split to stay under the 500-line cap).

export interface VendorWithScore {
  id: string;
  company_name: string;
  contact_person: string | null;
  phone: string | null;
  category: string | null;
  status: string;
  score: VendorScore | null;
}

export interface VendorDirectoryEntry {
  id: string;
  company_name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  category: string | null;
  status: string;
  score: VendorScore | null;
  services: string[];
  groups: string[];
  sku_count: number;
}

export interface VendorInput {
  id?: string;
  company_name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  category?: string | null;
  status: string;
}

/**
 * Vendor intelligence — scores, directory, vendor CRUD (Vastos_ARC's
 * src/boq/vendorApi.ts). Split from BoqService (already at the project's
 * 500-line file cap) rather than appended to it.
 *
 * fetchVendorsWithScores() is public and reused by BoqVendorSkuService (for
 * candidate scoring) via DI — each call opens its own withCaller()
 * transaction rather than sharing one across services, a minor consistency
 * trade (score snapshot could theoretically differ by a few ms between two
 * reads in the same request) for keeping both files independently readable.
 *
 * fetchProcurementForBoq() is NOT ported here — it's pure client-side
 * projection (procurementView()) over fetchBoqDetail(), which vendorApi.ts
 * already gets from the already-migrated boq/quotationApi.ts. Nothing to do.
 */
@Injectable()
export class BoqVendorService {
  constructor(private readonly db: DatabaseService) {}

  fetchVendorsWithScores(authUid: string): Promise<VendorWithScore[]> {
    return this.db.withCaller(authUid, (client) => this.vendorsWithScores(client));
  }

  private async vendorsWithScores(client: PoolClient): Promise<VendorWithScore[]> {
    const vendors = await client.query<{
      id: string;
      company_name: string;
      contact_person: string | null;
      phone: string | null;
      category: string | null;
      status: string;
    }>(
      `select id, company_name, contact_person, phone, category, status
         from vendors
        where firm_id = current_firm_id()
        order by company_name`,
    );
    const perf = await client.query<{ vendor_id: string } & PerfRow>(
      `select vendor_id, promised_days, actual_days, qty_ordered, qty_defective, price_at_order, market_price, recorded_at
         from vendor_performance
        where firm_id = current_firm_id()`,
    );
    const byVendor = new Map<string, PerfRow[]>();
    for (const r of perf.rows) {
      const arr = byVendor.get(r.vendor_id) ?? [];
      arr.push(r);
      byVendor.set(r.vendor_id, arr);
    }
    return vendors.rows.map((v) => ({
      id: v.id,
      company_name: v.company_name,
      contact_person: v.contact_person,
      phone: v.phone,
      category: v.category,
      status: v.status,
      score: computeVendorScore(byVendor.get(v.id) ?? []),
    }));
  }

  /** Recompute scores from performance and persist to vendors' denormalized
   * columns, in the same transaction as the read (a correctness improvement
   * over the frontend original's separate fetch-then-N-updates). */
  recomputeAndPersistScores(authUid: string): Promise<number> {
    return this.db.withCaller(authUid, async (client) => {
      const vendors = await this.vendorsWithScores(client);
      let n = 0;
      for (const v of vendors) {
        if (!v.score) continue;
        await client.query(
          `update vendors
              set cost_score = $1, delivery_score = $2, quality_score = $3, reliability_score = $4, overall_score = $5
            where id = $6`,
          [v.score.cost, v.score.delivery, v.score.quality, v.score.reliability, v.score.overall, v.id],
        );
        n++;
      }
      return n;
    });
  }

  /** Group heading = the catalog category at depth 2 of its ltree path
   * (e.g. material.boards.plywood → "Boards"). */
  private deriveGroup(path: string, pathToName: Map<string, string>, leafName: string): string {
    const groupPath = path.split('.').slice(0, 2).join('.');
    return pathToName.get(groupPath) ?? pathToName.get(path) ?? leafName;
  }

  fetchVendorDirectory(authUid: string): Promise<VendorDirectoryEntry[]> {
    return this.db.withCaller(authUid, async (client) => {
      const vendors = await client.query<{
        id: string;
        company_name: string;
        contact_person: string | null;
        phone: string | null;
        email: string | null;
        gstin: string | null;
        category: string | null;
        status: string;
      }>(
        `select id, company_name, contact_person, phone, email, gstin, category, status
           from vendors
          where firm_id = current_firm_id()
          order by company_name`,
      );
      const perf = await client.query<{ vendor_id: string } & PerfRow>(
        `select vendor_id, promised_days, actual_days, qty_ordered, qty_defective, price_at_order, market_price, recorded_at
           from vendor_performance
          where firm_id = current_firm_id()`,
      );
      const vskus = await client.query<{ vendor_id: string; category_id: string | null }>(
        `select vs.vendor_id, cp.category_id
           from vendor_skus vs
           join product_skus ps on ps.id = vs.sku_id
           left join catalog_products cp on cp.id = ps.product_id
          where vs.firm_id = current_firm_id()`,
      );
      const cats = await client.query<{ id: string; name: string; path: string }>(
        `select id, name, path from catalog_categories`,
      );

      const catById = new Map<string, { name: string; path: string }>();
      const pathToName = new Map<string, string>();
      for (const c of cats.rows) {
        catById.set(c.id, { name: c.name, path: c.path });
        pathToName.set(c.path, c.name);
      }

      const perfByVendor = new Map<string, PerfRow[]>();
      for (const r of perf.rows) {
        const arr = perfByVendor.get(r.vendor_id) ?? [];
        arr.push(r);
        perfByVendor.set(r.vendor_id, arr);
      }

      const services = new Map<string, Set<string>>();
      const groups = new Map<string, Set<string>>();
      const skuCount = new Map<string, number>();
      for (const r of vskus.rows) {
        skuCount.set(r.vendor_id, (skuCount.get(r.vendor_id) ?? 0) + 1);
        const cat = r.category_id ? catById.get(r.category_id) : undefined;
        if (!cat) continue;
        if (!services.has(r.vendor_id)) services.set(r.vendor_id, new Set());
        if (!groups.has(r.vendor_id)) groups.set(r.vendor_id, new Set());
        services.get(r.vendor_id)!.add(cat.name);
        groups.get(r.vendor_id)!.add(this.deriveGroup(cat.path, pathToName, cat.name));
      }

      return vendors.rows.map((v) => ({
        id: v.id,
        company_name: v.company_name,
        contact_person: v.contact_person,
        phone: v.phone,
        email: v.email,
        gstin: v.gstin,
        category: v.category,
        status: v.status,
        score: computeVendorScore(perfByVendor.get(v.id) ?? []),
        services: [...(services.get(v.id) ?? [])].sort(),
        groups: [...(groups.get(v.id) ?? [])].sort(),
        sku_count: skuCount.get(v.id) ?? 0,
      }));
    });
  }

  /** Insert a new vendor or update an existing one. createdBy is resolved
   * from the verified session on insert, not a client-supplied value. */
  saveVendor(authUid: string, input: VendorInput): Promise<string> {
    return this.db.withCaller(authUid, async (client) => {
      const fields = {
        company_name: input.company_name.trim(),
        contact_person: input.contact_person?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        gstin: input.gstin?.trim() || null,
        category: input.category?.trim() || null,
        status: input.status,
      };
      if (input.id) {
        await client.query(
          `update vendors
              set company_name = $1, contact_person = $2, phone = $3, email = $4, gstin = $5, category = $6, status = $7
            where id = $8`,
          [
            fields.company_name,
            fields.contact_person,
            fields.phone,
            fields.email,
            fields.gstin,
            fields.category,
            fields.status,
            input.id,
          ],
        );
        return input.id;
      }
      const { rows: meRows } = await client.query<{ id: string }>(
        `select id from profiles where auth_uid = $1 limit 1`,
        [authUid],
      );
      const createdBy = meRows[0]?.id ?? null;
      const { rows } = await client.query<{ id: string }>(
        `insert into vendors (firm_id, created_by, company_name, contact_person, phone, email, gstin, category, status)
         values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          createdBy,
          fields.company_name,
          fields.contact_person,
          fields.phone,
          fields.email,
          fields.gstin,
          fields.category,
          fields.status,
        ],
      );
      return rows[0].id;
    });
  }
}
