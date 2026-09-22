import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InvoicesService } from './invoices.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

interface IssueBody {
  splitId?: unknown;
  clientEntityId?: unknown;
}

interface VoidBody {
  reason?: unknown;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

@Controller('api/invoices')
@UseGuards(SupabaseAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('issue')
  async issue(@Body() body: IssueBody, @Req() req: AuthedRequest) {
    const splitId = requireId(body.splitId, 'splitId');
    const entityId =
      typeof body.clientEntityId === 'string' && body.clientEntityId !== ''
        ? body.clientEntityId
        : null;
    const row = await this.invoices.issue(req.user.id, splitId, entityId);
    if (!row) throw new NotFoundException('invoice could not be issued');
    return row;
  }

  @Post(':id/void')
  async void(
    @Param('id') id: string,
    @Body() body: VoidBody,
    @Req() req: AuthedRequest,
  ) {
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const row = await this.invoices.void(req.user.id, id, reason);
    if (!row) throw new NotFoundException(`invoice ${id} not found`);
    return row;
  }
}
