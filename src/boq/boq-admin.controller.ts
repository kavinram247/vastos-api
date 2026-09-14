import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  BoqAdminTemplatesService,
  type CreateTemplateInput,
  type RuleAdminRow,
  type TemplateMetaPatch,
} from './boq-admin-templates.service';
import { BoqAdminService, type RegionAdminPatch } from './boq-admin.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/boq/admin')
@UseGuards(SupabaseAuthGuard)
export class BoqAdminController {
  constructor(
    private readonly admin: BoqAdminService,
    private readonly templates: BoqAdminTemplatesService,
  ) {}

  @Get('materials')
  materials(@Req() req: AuthedRequest) {
    return this.admin.fetchMaterialRows(req.user.id);
  }

  @Post('materials/:skuId/rate')
  async saveMaterialRate(
    @Param('skuId') skuId: string,
    @Body() body: { rate: number },
    @Req() req: AuthedRequest,
  ) {
    await this.admin.saveMaterialRate(req.user.id, skuId, body.rate);
    return { ok: true };
  }

  @Post('products/:id/override')
  async saveProductWaste(
    @Param('id') id: string,
    @Body() body: { waste: number },
    @Req() req: AuthedRequest,
  ) {
    await this.admin.saveProductWaste(req.user.id, id, body.waste);
    return { ok: true };
  }

  @Delete('products/:id/override')
  async clearProductOverride(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.admin.clearProductOverride(req.user.id, id);
    return { ok: true };
  }

  @Get('labour')
  labour(@Req() req: AuthedRequest) {
    return this.admin.fetchLabourRows(req.user.id);
  }

  @Post('labour/:activityId/rate')
  async saveLabourRate(
    @Param('activityId') activityId: string,
    @Body() body: { rate: number },
    @Req() req: AuthedRequest,
  ) {
    await this.admin.saveLabourRate(req.user.id, activityId, body.rate);
    return { ok: true };
  }

  @Get('margin')
  margin(@Req() req: AuthedRequest) {
    return this.admin.fetchMargin(req.user.id);
  }

  @Post('margin/ensure')
  ensureMargin(@Req() req: AuthedRequest) {
    return this.admin.ensureMargin(req.user.id);
  }

  @Patch('margin/:id')
  async saveMargin(
    @Param('id') id: string,
    @Body() body: { target_margin_pct: number; margin_floor_pct: number; overhead_pct: number },
    @Req() req: AuthedRequest,
  ) {
    await this.admin.saveMargin(req.user.id, id, body);
    return { ok: true };
  }

  @Patch('regions/:id')
  async saveRegion(
    @Param('id') id: string,
    @Body() body: RegionAdminPatch,
    @Req() req: AuthedRequest,
  ) {
    await this.admin.saveRegion(req.user.id, id, body);
    return { ok: true };
  }

  @Get('products-simple')
  productsSimple(@Req() req: AuthedRequest) {
    return this.admin.fetchProductsSimple(req.user.id);
  }

  @Get('labour-simple')
  labourSimple(@Req() req: AuthedRequest) {
    return this.admin.fetchLabourSimple(req.user.id);
  }

  @Get('templates')
  templatesAdmin(@Req() req: AuthedRequest) {
    return this.templates.fetchTemplatesAdmin(req.user.id);
  }

  @Post('templates')
  async createTemplate(@Body() body: CreateTemplateInput, @Req() req: AuthedRequest) {
    const id = await this.templates.createTemplateFull(req.user.id, body);
    return { id };
  }

  @Post('templates/:id/active')
  async updateTemplateActive(
    @Param('id') id: string,
    @Body() body: { is_active: boolean },
    @Req() req: AuthedRequest,
  ) {
    const templateId = await this.templates.updateTemplateActive(req.user.id, id, body.is_active);
    return { id: templateId };
  }

  @Patch('templates/:id')
  async saveTemplateMeta(
    @Param('id') id: string,
    @Body() body: TemplateMetaPatch,
    @Req() req: AuthedRequest,
  ) {
    const templateId = await this.templates.saveTemplateMeta(req.user.id, id, body);
    return { id: templateId };
  }

  @Post('rules')
  saveRule(@Body() body: Omit<RuleAdminRow, 'id'>, @Req() req: AuthedRequest) {
    return this.templates.saveRule(req.user.id, body);
  }

  @Patch('rules/:id')
  updateRule(
    @Param('id') id: string,
    @Body() body: Partial<Omit<RuleAdminRow, 'id'>>,
    @Req() req: AuthedRequest,
  ) {
    return this.templates.updateRule(req.user.id, id, body);
  }

  @Delete('rules/:id')
  deleteRule(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.templates.deleteRule(req.user.id, id);
  }
}
