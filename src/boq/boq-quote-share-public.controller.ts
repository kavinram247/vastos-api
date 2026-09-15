import { Body, Controller, Get, HttpException, Param, Post } from '@nestjs/common';
import { BoqQuoteShareService } from './boq-quote-share.service';

// No SupabaseAuthGuard — a client opening a shared quote link has no
// session by definition. Served from Vastos_ARC's own SPA (ClientQuotePage),
// so no CORS carve-out is needed: the browser's Origin is already the
// frontend's own, already in ALLOWED_ORIGINS. The share token is the entire
// trust boundary, enforced inside quote_public_view/accept_quote themselves.
//
// Both RPCs raise business-specific messages (already accepted, no BOQ to
// price, missing signatory name) that ClientQuotePage.tsx already surfaces
// verbatim via error.message — map SQLSTATE to a status but keep the RPC's
// own message, rather than collapsing everything to a generic 500.
const STATUS_FOR: Record<string, number> = {
  '42704': 404, // quote not found (bad/unknown token)
  '22023': 400, // validation (signatory name, no BOQ to price)
  '23505': 409, // already accepted — replay guard
};

function rethrow(err: any): never {
  const code = err?.code as string | undefined;
  const status = STATUS_FOR[code ?? ''] ?? 500;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[boq-quote-share]', code, err?.message);
  }
  throw new HttpException(
    { error: status === 500 ? 'could not process this request' : err?.message },
    status,
  );
}

@Controller('api/boq/quotes')
export class BoqQuoteSharePublicController {
  constructor(private readonly quoteShare: BoqQuoteShareService) {}

  @Get(':token')
  async view(@Param('token') token: string) {
    try {
      return await this.quoteShare.fetchPublicQuote(token);
    } catch (err: any) {
      rethrow(err);
    }
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: { name?: string; selectedOptionalIds?: string[] },
  ) {
    try {
      return await this.quoteShare.acceptQuote(
        token,
        body.name ?? '',
        Array.isArray(body.selectedOptionalIds) ? body.selectedOptionalIds : [],
      );
    } catch (err: any) {
      rethrow(err);
    }
  }
}
