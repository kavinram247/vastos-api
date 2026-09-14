import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

// Straight passthrough of each crm_ad_*/crm_sync_runs/crm_marketing_attribution
// row — no reshaping. bigint/numeric columns (crm_ad_insights, revenue) come
// back from node-postgres as strings rather than PostgREST's bare JSON
// numbers, but the frontend's coerceInsights()/coerceAttribution() already
// wrap every such field in Number(v), so this is invisible to callers.
export interface MarketingDataPayload {
  accounts: Record<string, unknown>[];
  campaigns: Record<string, unknown>[];
  adSets: Record<string, unknown>[];
  ads: Record<string, unknown>[];
  insights: Record<string, unknown>[];
  adLeads: Record<string, unknown>[];
  attribution: Record<string, unknown>[];
  syncRuns: Record<string, unknown>[];
}

/**
 * Marketing/ads analytics (Vastos_ARC's src/marketing/marketingApi.ts).
 * setAccountStatus()/setSyncInterval() go through the generic
 * /api/data/crm_ad_accounts layer instead (plain update by id) — see
 * db/table-registry.ts.
 */
@Injectable()
export class MarketingService {
  constructor(private readonly db: DatabaseService) {}

  fetchMarketingData(authUid: string): Promise<MarketingDataPayload> {
    return this.db.withCaller(authUid, async (client) => {
      // Sequential, not Promise.all on one client — see the established
      // node-postgres-queues-per-client lesson from firm.service.ts/boq.service.ts.
      const accounts = await client.query(
        `select * from crm_ad_accounts where firm_id = current_firm_id() order by created_at asc`,
      );
      const campaigns = await client.query(
        `select * from crm_ad_campaigns where firm_id = current_firm_id()`,
      );
      const adSets = await client.query(`select * from crm_ad_sets where firm_id = current_firm_id()`);
      const ads = await client.query(`select * from crm_ads where firm_id = current_firm_id()`);
      const insights = await client.query(
        `select * from crm_ad_insights where firm_id = current_firm_id()`,
      );
      const adLeads = await client.query(`select * from crm_ad_leads where firm_id = current_firm_id()`);
      const attribution = await client.query(
        `select * from crm_marketing_attribution where firm_id = current_firm_id()`,
      );
      const syncRuns = await client.query(
        `select * from crm_sync_runs where firm_id = current_firm_id() order by started_at desc`,
      );

      return {
        accounts: accounts.rows,
        campaigns: campaigns.rows,
        adSets: adSets.rows,
        ads: ads.rows,
        insights: insights.rows,
        adLeads: adLeads.rows,
        attribution: attribution.rows,
        syncRuns: syncRuns.rows,
      };
    });
  }

  /** Record a sync run + stamp the account's last_synced_at, in one
   * transaction (the frontend original did these as two separate round
   * trips with no rollback). */
  async recordSyncRun(
    authUid: string,
    accountId: string,
    rows: number,
    trigger: 'manual' | 'mock',
  ): Promise<void> {
    await this.db.withCaller(authUid, async (client) => {
      const now = new Date().toISOString();
      await client.query(
        `insert into crm_sync_runs (firm_id, ad_account_id, provider, status, trigger, rows_upserted, started_at, finished_at)
         values (current_firm_id(), $1, 'meta', 'success', $2, $3, $4, $4)`,
        [accountId, trigger, rows, now],
      );
      await client.query(`update crm_ad_accounts set last_synced_at = $1 where id = $2`, [now, accountId]);
    });
  }
}
