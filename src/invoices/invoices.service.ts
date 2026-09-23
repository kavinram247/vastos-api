import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/** Mirrors the crm_invoices row shape the migration defines. */
export interface Invoice {
  id: string;
  firm_id: string;
  project_id: string;
  payment_split_id: string;
  invoice_number: string;
  invoice_date: string;
  fy: string;
  client_entity_id: string | null;
  bill_to_name: string;
  bill_to_gstin: string | null;
  bill_to_address: string | null;
  issuer_name: string;
  issuer_gstin: string | null;
  issuer_address: string | null;
  amount: string;
  gst_rate: string;
  gst_amount: string;
  total_with_gst: string;
  status: 'issued' | 'void';
  issued_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

@Injectable()
export class InvoicesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Issue the invoice for a payment split, or return the one already issued.
   *
   * Everything of consequence happens inside crm_issue_invoice(): allocating
   * the next number in the firm's financial-year series, and copying the
   * issuer and recipient details onto the row so the document stops tracking
   * live data. It has to be one statement — two users opening the same
   * project would otherwise race for the same invoice number — and it is
   * idempotent per split, so opening the dialog twice does not burn a number.
   */
  issue(authUid: string, splitId: string, clientEntityId?: string | null) {
    return this.db.withCaller(authUid, async (client) => {
      try {
        const { rows } = await client.query<Invoice>(
          'select * from crm_issue_invoice($1, $2)',
          [splitId, clientEntityId ?? null],
        );
        return rows[0];
      } catch (err) {
        throw translatePgError(err);
      }
    });
  }

  /** Void an issued invoice. The column guard in the migration reduces an
   *  update to exactly this, and stamps voided_at itself. */
  void(authUid: string, id: string, reason: string | null) {
    return this.db.withCaller(authUid, async (client) => {
      try {
        const { rows } = await client.query<Invoice>(
          `update crm_invoices set status = 'void', void_reason = $2
            where id = $1 returning *`,
          [id, reason],
        );
        return rows[0];
      } catch (err) {
        throw translatePgError(err);
      }
    });
  }
}

/**
 * crm_issue_invoice() and the invoice guard trigger reject bad input by raising,
 * and an unmapped raise reaches the browser as a bare 500 — which tells whoever
 * clicked Issue nothing at all. These are the caller's problem, not the
 * server's, so give them their real status and message:
 *
 *   22023 invalid_parameter_value  — unknown split, unknown entity, an entity
 *                                    belonging to a different client
 *   42501 insufficient_privilege   — no firm in session, or an attempt to edit
 *                                    or reinstate an issued invoice
 *
 * Anything else is genuinely ours and stays a 500 with its detail logged rather
 * than shown.
 */
function translatePgError(err: unknown): Error {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? 'invoice request failed';
  if (code === '22023') return new BadRequestException(message);
  if (code === '42501') return new ForbiddenException(message);
  return new InternalServerErrorException('Could not issue the invoice');
}
