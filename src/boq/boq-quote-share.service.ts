import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface ScheduleWithMilestones {
  total_amount: number;
  split_count: number;
  signed_name: string | null;
  signed_at: string | null;
  milestones: {
    split_number: number;
    label: string;
    percent: number;
    amount: number;
    gst_amount: number;
    total_with_gst: number;
  }[];
}

/**
 * Quote-to-cash's public half (Vastos_ARC's src/boq/quoteShareApi.ts).
 * quote_public_view/accept_quote are SECURITY DEFINER RPCs that resolve the
 * quotation entirely by its share_token, taking no auth.uid() at all — the
 * same trust boundary they had running under Postgres's `anon` role via
 * PostgREST. getShareToken/fetchSchedule are the authenticated half (the
 * firm's own dashboard reading back a link/schedule it already generated),
 * still firm-scoped through withCaller/current_firm_id().
 */
@Injectable()
export class BoqQuoteShareService {
  constructor(private readonly db: DatabaseService) {}

  getShareToken(authUid: string, quotationId: string): Promise<string | null> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<{ share_token: string }>(
        `select share_token from quotations where id = $1 and firm_id = current_firm_id()`,
        [quotationId],
      );
      return rows[0]?.share_token ?? null;
    });
  }

  fetchSchedule(
    authUid: string,
    quotationId: string,
  ): Promise<ScheduleWithMilestones | null> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows: sched } = await client.query(
        `select ps.id, ps.total_amount, ps.split_count, ps.signed_name, ps.signed_at
           from payment_schedules ps
           join quotations q on q.id = ps.quotation_id
          where ps.quotation_id = $1 and q.firm_id = current_firm_id()
          order by ps.created_at desc
          limit 1`,
        [quotationId],
      );
      const s = sched[0];
      if (!s) return null;

      const { rows: milestones } = await client.query(
        `select split_number, label, percent, amount, gst_amount, total_with_gst
           from payment_milestones where schedule_id = $1 order by split_number`,
        [s.id],
      );
      return {
        total_amount: Number(s.total_amount),
        split_count: s.split_count,
        signed_name: s.signed_name,
        signed_at: s.signed_at,
        milestones: milestones.map((m) => ({
          split_number: m.split_number,
          label: m.label,
          percent: Number(m.percent),
          amount: Number(m.amount),
          gst_amount: Number(m.gst_amount),
          total_with_gst: Number(m.total_with_gst),
        })),
      };
    });
  }

  fetchPublicQuote(token: string): Promise<unknown> {
    return this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: unknown }>(
        `select quote_public_view($1::uuid) as result`,
        [token],
      );
      return rows[0].result;
    });
  }

  acceptQuote(
    token: string,
    name: string,
    selectedOptionalIds: string[],
  ): Promise<unknown> {
    return this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: unknown }>(
        `select accept_quote($1::uuid, $2, $3::uuid[]) as result`,
        [token, name, selectedOptionalIds],
      );
      return rows[0].result;
    });
  }
}
