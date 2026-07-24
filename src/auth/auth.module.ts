import { Global, Module } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { CallerContextService } from './caller-context.service';

@Global()
@Module({
  providers: [SupabaseAuthGuard, CallerContextService],
  exports: [SupabaseAuthGuard, CallerContextService],
})
export class AuthModule {}
