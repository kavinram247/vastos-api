import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { SupabaseModule } from './supabase/supabase.module';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { FirmModule } from './firm/firm.module';
import { DataModule } from './data/data.module';
import { LeadsModule } from './leads/leads.module';
import { BoqModule } from './boq/boq.module';
import { TasksModule } from './tasks/tasks.module';
import { AttendanceModule } from './attendance/attendance.module';
import { MarketingModule } from './marketing/marketing.module';
import { InventoryModule } from './inventory/inventory.module';
import { PurchaseModule } from './purchase/purchase.module';
import { VendorAccessModule } from './vendor-access/vendor-access.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    DocumentsModule,
    FirmModule,
    DataModule,
    LeadsModule,
    BoqModule,
    TasksModule,
    AttendanceModule,
    MarketingModule,
    InventoryModule,
    PurchaseModule,
    VendorAccessModule,
  ],
})
export class AppModule {}
