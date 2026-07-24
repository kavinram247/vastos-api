import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CallerContextService } from '../auth/caller-context.service';
import { SupabaseService } from '../supabase/supabase.service';
import { DocumentsService } from './documents.service';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface PresignUploadBody {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

@Controller('documents')
@UseGuards(SupabaseAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly callerContext: CallerContextService,
    private readonly supabase: SupabaseService,
  ) {}

  @Post(':projectId/presign-upload')
  async presignUpload(
    @Param('projectId') projectId: string,
    @Body() body: PresignUploadBody,
    @Req() req: Request & { user: { id: string; email?: string } },
  ) {
    const ctx = await this.callerContext.resolve(req.user);
    if (!ctx) throw new ForbiddenException();
    if (ctx.isReadOnlyViewer) {
      throw new ForbiddenException('No permission to upload documents');
    }
    if (!body?.filename || !body?.contentType || !body?.sizeBytes) {
      throw new BadRequestException(
        'filename, contentType, sizeBytes required',
      );
    }
    if (body.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds 25MB limit');
    }

    const db = this.supabase.getServiceRoleClient();
    const { data: project } = await db
      .from('crm_projects')
      .select('id')
      .eq('id', projectId)
      .eq('firm_id', ctx.firmId)
      .maybeSingle();
    if (!project) throw new NotFoundException('Project not found');

    const objectKey = this.documents.buildObjectKey(ctx.firmId, projectId);
    const uploadUrl = await this.documents.presignUpload(
      objectKey,
      body.contentType,
    );
    return { uploadUrl, objectKey, expiresIn: 600 };
  }

  @Get(':documentId/presign-download')
  async presignDownload(
    @Param('documentId') documentId: string,
    @Query('disposition') disposition: 'inline' | 'attachment' = 'inline',
    @Req() req: Request & { user: { id: string; email?: string } },
  ) {
    const ctx = await this.callerContext.resolve(req.user);
    if (!ctx) throw new ForbiddenException();

    const db = this.supabase.getServiceRoleClient();
    const { data: doc } = await db
      .from('crm_project_documents')
      .select('file_url,name,visible_to_client')
      .eq('id', documentId)
      .eq('firm_id', ctx.firmId)
      .maybeSingle();
    if (!doc) throw new NotFoundException('Document not found');

    const row = doc as {
      file_url: string;
      name: string;
      visible_to_client: boolean;
    };
    // 404, not 403 — don't confirm existence to someone who shouldn't see it.
    if (ctx.isReadOnlyViewer && !row.visible_to_client) {
      throw new NotFoundException('Document not found');
    }
    if (!row.file_url || row.file_url === '#') {
      throw new NotFoundException('File not available');
    }

    const downloadUrl = await this.documents.presignDownload(
      row.file_url,
      row.name,
      disposition === 'attachment' ? 'attachment' : 'inline',
    );
    return { downloadUrl, expiresIn: 300 };
  }
}
