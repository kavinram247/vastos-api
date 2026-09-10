import { Module } from '@nestjs/common';
import { FirmController } from './firm.controller';
import { FirmService } from './firm.service';

@Module({
  controllers: [FirmController],
  providers: [FirmService],
})
export class FirmModule {}
