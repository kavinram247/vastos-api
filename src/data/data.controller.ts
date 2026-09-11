import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DataService } from './data.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

interface WhereBody {
  match: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

@Controller('api/data')
@UseGuards(SupabaseAuthGuard)
export class DataController {
  constructor(private readonly data: DataService) {}

  @Get(':table/:id')
  getOne(
    @Param('table') table: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.data.getOne(req.user.id, table, id);
  }

  @Post(':table')
  insert(
    @Param('table') table: string,
    @Body() row: Record<string, unknown>,
    @Req() req: AuthedRequest,
  ) {
    return this.data.insert(req.user.id, table, row);
  }

  @Patch(':table/:id')
  update(
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() patch: Record<string, unknown>,
    @Req() req: AuthedRequest,
  ) {
    return this.data.update(req.user.id, table, id, patch);
  }

  @Delete(':table/:id')
  delete(
    @Param('table') table: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.data.delete(req.user.id, table, id);
  }

  // Bulk variants — no :id, the match/patch (or match alone) travel in the
  // body. Mirrors crmApi.ts's persistUpdateWhere / persistDeleteWhere.
  @Patch(':table')
  async updateWhere(
    @Param('table') table: string,
    @Body() body: WhereBody,
    @Req() req: AuthedRequest,
  ) {
    const count = await this.data.updateWhere(
      req.user.id,
      table,
      body.match,
      body.patch ?? {},
    );
    return { updated: count };
  }

  @Delete(':table')
  async deleteWhere(
    @Param('table') table: string,
    @Body() body: WhereBody,
    @Req() req: AuthedRequest,
  ) {
    const count = await this.data.deleteWhere(req.user.id, table, body.match);
    return { deleted: count };
  }
}
