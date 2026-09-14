import { Module } from '@nestjs/common';
import { BoqAdminTemplatesService } from './boq-admin-templates.service';
import { BoqAdminController } from './boq-admin.controller';
import { BoqAdminService } from './boq-admin.service';
import { BoqVendorSkuService } from './boq-vendor-sku.service';
import { BoqVendorController } from './boq-vendor.controller';
import { BoqVendorService } from './boq-vendor.service';
import { BoqController } from './boq.controller';
import { BoqService } from './boq.service';

@Module({
  controllers: [BoqController, BoqAdminController, BoqVendorController],
  providers: [
    BoqService,
    BoqAdminService,
    BoqAdminTemplatesService,
    BoqVendorService,
    BoqVendorSkuService,
  ],
})
export class BoqModule {}
