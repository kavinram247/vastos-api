import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { SupabaseModule } from './supabase/supabase.module';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { FirmModule } from './firm/firm.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    DocumentsModule,
    FirmModule,
  ],
})
export class AppModule {}
