import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CallerContextService } from '../auth/caller-context.service';
import {
  AttendanceService,
  type GeoFix,
  type ManualAttendanceInput,
} from './attendance.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/attendance')
@UseGuards(SupabaseAuthGuard)
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly callerContext: CallerContextService,
  ) {}

  @Get()
  list(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('userId') userId: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.attendance.listAttendance(req.user.id, { from, to, userId });
  }

  @Get('today')
  today(@Query('userId') userId: string, @Req() req: AuthedRequest) {
    return this.attendance.getTodayRecord(req.user.id, userId);
  }

  @Post('check-in')
  async checkIn(
    @Body()
    body: { user: { id: string; name: string }; geo: GeoFix | null; label: string | null; markedBy: string },
    @Req() req: AuthedRequest,
  ) {
    await this.attendance.checkIn(req.user.id, body.user, body.geo, body.label, body.markedBy);
    return { ok: true };
  }

  // Regularization, not self-service (VASTOS-013). attendance_records' RLS
  // rejects this for non-admins anyway; the check here is so they get a clean
  // 403 instead of a database error.
  @Post('manual')
  async manual(
    @Body() body: { input: ManualAttendanceInput; markedBy: string },
    @Req() req: AuthedRequest,
  ) {
    const ctx = await this.callerContext.resolve(req.user);
    if (!ctx) throw new ForbiddenException();
    if (!ctx.isAdmin) {
      throw new ForbiddenException('Only an owner or admin can regularize attendance');
    }
    await this.attendance.saveManualAttendance(req.user.id, body.input, body.markedBy);
    return { ok: true };
  }
}
