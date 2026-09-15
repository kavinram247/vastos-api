import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BoqQuoteShareService } from './boq-quote-share.service';
import {
  BoqService,
  type SaveBoqInput,
  type SaveQuotationInput,
} from './boq.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/boq')
@UseGuards(SupabaseAuthGuard)
export class BoqController {
  constructor(
    private readonly boq: BoqService,
    private readonly quoteShare: BoqQuoteShareService,
  ) {}

  @Get('regions')
  regions(@Req() req: AuthedRequest) {
    return this.boq.fetchRegions(req.user.id);
  }

  @Get('templates')
  templates(@Req() req: AuthedRequest) {
    return this.boq.fetchTemplates(req.user.id);
  }

  @Get('pricing-context')
  pricingContext(
    @Query('regionId') regionId: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.boq.fetchPricingContext(req.user.id, regionId ?? null);
  }

  @Get('documents')
  documents(@Req() req: AuthedRequest) {
    return this.boq.listBoqs(req.user.id);
  }

  @Post('documents')
  async save(@Body() input: SaveBoqInput, @Req() req: AuthedRequest) {
    const id = await this.boq.saveBoq(req.user.id, input);
    return { id };
  }

  @Get('documents/:id/detail')
  detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.boq.fetchBoqDetail(req.user.id, id);
  }

  @Get('quotations')
  quotations(@Req() req: AuthedRequest) {
    return this.boq.listQuotations(req.user.id);
  }

  @Post('quotations')
  saveQuotation(@Body() input: SaveQuotationInput, @Req() req: AuthedRequest) {
    return this.boq.saveQuotation(req.user.id, input);
  }

  @Get('quotations/:id/share-token')
  shareToken(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.quoteShare.getShareToken(req.user.id, id);
  }

  @Get('quotations/:id/schedule')
  schedule(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.quoteShare.fetchSchedule(req.user.id, id);
  }

  @Get('calibration/variance-summary')
  varianceSummary(@Req() req: AuthedRequest) {
    return this.boq.fetchVarianceSummary(req.user.id);
  }

  @Post('calibration/run')
  runCalibration(
    @Body() body: { regionId: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.boq.runCalibration(req.user.id, body.regionId ?? null);
  }

  @Get('calibration/history')
  calibrationHistory(@Req() req: AuthedRequest) {
    return this.boq.fetchCalibrationHistory(req.user.id);
  }

  @Post('documents/:id/reconcile')
  async reconcile(
    @Param('id') id: string,
    @Body() body: { regionId: string | null },
    @Req() req: AuthedRequest,
  ) {
    const count = await this.boq.reconcileBoqFromActuals(
      req.user.id,
      id,
      body.regionId ?? null,
    );
    return { count };
  }
}
