import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PurchaseMastersService } from './purchase-masters.service';

type AuthedRequest = Request & { user: { id: string; email?: string; firmId?: string } };

@Controller('api/purchase')
@UseGuards(SupabaseAuthGuard)
export class PurchaseMastersController {
  constructor(private readonly masters: PurchaseMastersService) {}

  @Get('vendors')
  listVendors(@Req() req: AuthedRequest) {
    return this.masters.listVendors(req.user.id);
  }

  @Post('vendors')
  saveVendor(
    @Body()
    body: {
      id?: string; company_name: string; vendor_code?: string | null; contact_person?: string | null;
      phone?: string | null; email?: string | null; gstin?: string | null; category?: string | null;
      credit_days?: number | null; payment_terms?: string | null; status: string; notes?: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.masters.saveVendor(req.user.id, body);
  }

  @Delete('vendors/:id')
  deleteVendor(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.masters.deleteVendor(req.user.id, id);
  }

  @Get('catalog-categories')
  listCatalogCategories(@Req() req: AuthedRequest) {
    return this.masters.listCatalogCategories(req.user.id);
  }

  @Get('materials')
  listMaterials(@Req() req: AuthedRequest) {
    return this.masters.listMaterials(req.user.id);
  }

  @Post('materials')
  saveMaterial(
    @Body()
    body: {
      id?: string; name: string; category_id: string; base_uom: string;
      hsn_code?: string | null; gst_rate: number; description?: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.masters.saveMaterial(req.user.id, body);
  }

  @Post('materials/:id/deactivate')
  deactivateMaterial(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.masters.deactivateMaterial(req.user.id, id);
  }
}
