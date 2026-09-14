import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  BoqVendorSkuService,
  type POLineInput,
  type VendorSkuInput,
} from './boq-vendor-sku.service';
import { BoqVendorService, type VendorInput } from './boq-vendor.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/boq/vendors')
@UseGuards(SupabaseAuthGuard)
export class BoqVendorController {
  constructor(
    private readonly vendors: BoqVendorService,
    private readonly vendorSkus: BoqVendorSkuService,
  ) {}

  @Get('scores')
  scores(@Req() req: AuthedRequest) {
    return this.vendors.fetchVendorsWithScores(req.user.id);
  }

  @Post('scores/recompute')
  async recompute(@Req() req: AuthedRequest) {
    const count = await this.vendors.recomputeAndPersistScores(req.user.id);
    return { count };
  }

  @Get('directory')
  directory(@Req() req: AuthedRequest) {
    return this.vendors.fetchVendorDirectory(req.user.id);
  }

  @Post()
  async saveVendor(@Body() body: VendorInput, @Req() req: AuthedRequest) {
    const id = await this.vendors.saveVendor(req.user.id, body);
    return { id };
  }

  @Get('candidates')
  candidates(@Query('skuId') skuId: string, @Req() req: AuthedRequest) {
    return this.vendorSkus.fetchCandidatesForSku(req.user.id, skuId);
  }

  @Get('candidates-map')
  candidateMap(@Req() req: AuthedRequest) {
    return this.vendorSkus.fetchCandidateMap(req.user.id);
  }

  @Get('skus')
  skus(@Req() req: AuthedRequest) {
    return this.vendorSkus.listVendorSkus(req.user.id);
  }

  @Get('all-skus')
  allSkus(@Req() req: AuthedRequest) {
    return this.vendorSkus.fetchAllSkus(req.user.id);
  }

  @Post('po')
  async generatePO(
    @Body() body: { boqId: string; vendorId: string; lines: POLineInput[] },
    @Req() req: AuthedRequest,
  ) {
    const poNumber = await this.vendorSkus.generatePO(req.user.id, body.boqId, body.vendorId, body.lines);
    return { poNumber };
  }

  @Patch('sku-links/:id')
  async updateVendorSku(
    @Param('id') id: string,
    @Body() body: VendorSkuInput,
    @Req() req: AuthedRequest,
  ) {
    await this.vendorSkus.updateVendorSku(req.user.id, id, body);
    return { ok: true };
  }

  @Get(':vendorId/skus')
  vendorSkuLinks(@Param('vendorId') vendorId: string, @Req() req: AuthedRequest) {
    return this.vendorSkus.fetchVendorSkuLinks(req.user.id, vendorId);
  }

  @Post(':vendorId/skus/:skuId')
  async addVendorSku(
    @Param('vendorId') vendorId: string,
    @Param('skuId') skuId: string,
    @Body() body: VendorSkuInput,
    @Req() req: AuthedRequest,
  ) {
    await this.vendorSkus.addVendorSku(req.user.id, vendorId, skuId, body);
    return { ok: true };
  }

  @Delete(':vendorId/skus/:skuId')
  async removeVendorSku(
    @Param('vendorId') vendorId: string,
    @Param('skuId') skuId: string,
    @Req() req: AuthedRequest,
  ) {
    await this.vendorSkus.removeVendorSku(req.user.id, vendorId, skuId);
    return { ok: true };
  }
}
