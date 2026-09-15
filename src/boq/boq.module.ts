import { Module } from '@nestjs/common';
import { BoqAdminTemplatesService } from './boq-admin-templates.service';
import { BoqAdminController } from './boq-admin.controller';
import { BoqAdminService } from './boq-admin.service';
import { BoqQuoteSharePublicController } from './boq-quote-share-public.controller';
import { BoqQuoteShareService } from './boq-quote-share.service';
import { BoqVendorSkuService } from './boq-vendor-sku.service';
import { BoqVendorController } from './boq-vendor.controller';
import { BoqVendorService } from './boq-vendor.service';
import { BoqController } from './boq.controller';
import { BoqService } from './boq.service';

@Module({
  controllers: [
    BoqController,
    BoqAdminController,
    BoqVendorController,
    BoqQuoteSharePublicController,
  ],
  providers: [
    BoqService,
    BoqAdminService,
    BoqAdminTemplatesService,
    BoqVendorService,
    BoqVendorSkuService,
    BoqQuoteShareService,
  ],
})
export class BoqModule {}
