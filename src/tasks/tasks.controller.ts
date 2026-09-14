import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { TasksService } from './tasks.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('api/tasks')
@UseGuards(SupabaseAuthGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.tasks.listTasks(req.user.id);
  }

  @Get('lists')
  lists(@Req() req: AuthedRequest) {
    return this.tasks.listTaskLists(req.user.id);
  }

  @Get('subtasks')
  subtasks(@Req() req: AuthedRequest) {
    return this.tasks.listSubtasks(req.user.id);
  }

  @Get('activity/:taskId')
  activity(@Param('taskId') taskId: string, @Req() req: AuthedRequest) {
    return this.tasks.listActivity(req.user.id, taskId);
  }

  @Get('assign-privileges')
  assignPrivileges(@Req() req: AuthedRequest) {
    return this.tasks.listAssignPrivileges(req.user.id);
  }

  @Post('assign-privileges')
  async grantAssignPrivilege(
    @Body() body: { userId: string; userName: string; grantedBy: string },
    @Req() req: AuthedRequest,
  ) {
    await this.tasks.grantAssignPrivilege(req.user.id, body.userId, body.userName, body.grantedBy);
    return { ok: true };
  }

  @Delete('assign-privileges/:userId')
  async revokeAssignPrivilege(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    await this.tasks.revokeAssignPrivilege(req.user.id, userId);
    return { ok: true };
  }
}
