import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TableWriterService } from './table-writer.service';

@Global()
@Module({
  providers: [DatabaseService, TableWriterService],
  exports: [DatabaseService, TableWriterService],
})
export class DatabaseModule {}
