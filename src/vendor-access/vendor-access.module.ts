import { Module } from '@nestjs/common';
import { VendorAccessController } from './vendor-access.controller';
import { VendorAccessService } from './vendor-access.service';

@Module({
  controllers: [VendorAccessController],
  providers: [VendorAccessService],
})
export class VendorAccessModule {}
