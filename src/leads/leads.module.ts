import { Module } from '@nestjs/common';
import { LeadIntakePublicController } from './lead-intake-public.controller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  controllers: [LeadsController, LeadIntakePublicController],
  providers: [LeadsService],
})
export class LeadsModule {}
