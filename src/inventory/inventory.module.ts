import { Module } from '@nestjs/common';
import { InventoryReadsController } from './inventory-reads.controller';
import { InventoryReadsService } from './inventory-reads.service';
import { InventoryWritesController } from './inventory-writes.controller';
import { InventoryWritesService } from './inventory-writes.service';

@Module({
  controllers: [InventoryReadsController, InventoryWritesController],
  providers: [InventoryReadsService, InventoryWritesService],
})
export class InventoryModule {}
