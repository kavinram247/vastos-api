import { Module } from '@nestjs/common';
import { PurchaseMastersController } from './purchase-masters.controller';
import { PurchaseMastersService } from './purchase-masters.service';
import { PurchaseDocsController } from './purchase-docs.controller';
import { PurchaseDocsService } from './purchase-docs.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseStockController } from './purchase-stock.controller';
import { PurchaseStockService } from './purchase-stock.service';

@Module({
  controllers: [
    PurchaseMastersController,
    PurchaseDocsController,
    PurchaseOrdersController,
    PurchaseStockController,
  ],
  providers: [PurchaseMastersService, PurchaseDocsService, PurchaseOrdersService, PurchaseStockService],
})
export class PurchaseModule {}
