import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CallerContextService } from '../auth/caller-context.service';
import { DatabaseService } from '../db/database.service';
import { DocumentsService } from './documents.service';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type AuthedRequest = Request & { user: { id: string; email?: string } };

@Controller('documents')
@UseGuards(SupabaseAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly callerContext: CallerContextService,
    private readonly db: DatabaseService,
  ) {}

  // multipart/form-data, field name "file" — the browser sends the bytes
  // straight to us now (MinIO has no public endpoint to presign a URL for),
  // and we relay them over the private network it shares with Postgres.
  @Post(':projectId/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthedRequest,
  ) {
    const ctx = await this.callerContext.resolve(req.user);
    if (!ctx) throw new ForbiddenException();
    if (ctx.isReadOnlyViewer) {
      throw new ForbiddenException('No permission to upload documents');
    }
    if (!file) {
      throw new NotFoundException('No file provided');
    }

    const project = await this.db.withServiceRole(async (client) => {
      const { rows } = await client.query(
        `select id from crm_projects where id = $1 and firm_id = $2 limit 1`,
        [projectId, ctx.firmId],
      );
      return rows[0] ?? null;
    });
    if (!project) throw new NotFoundException('Project not found');

    const objectKey = this.documents.buildObjectKey(ctx.firmId, projectId);
    const contentType = file.mimetype || 'application/octet-stream';
    await this.documents.uploadObject(objectKey, contentType, file.buffer);
    return { objectKey, sizeBytes: file.size };
  }

  @Get(':documentId/download')
  async download(
    @Param('documentId') documentId: string,
    @Query('disposition') disposition: 'inline' | 'attachment' = 'inline',
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const ctx = await this.callerContext.resolve(req.user);
    if (!ctx) throw new ForbiddenException();

    const row = await this.db.withServiceRole(async (client) => {
      const { rows } = await client.query<{
        file_url: string;
        name: string;
        visible_to_client: boolean;
      }>(
        `select file_url, name, visible_to_client from crm_project_documents
          where id = $1 and firm_id = $2 limit 1`,
        [documentId, ctx.firmId],
      );
      return rows[0] ?? null;
    });
    if (!row) throw new NotFoundException('Document not found');
    // 404, not 403 — don't confirm existence to someone who shouldn't see it.
    if (ctx.isReadOnlyViewer && !row.visible_to_client) {
      throw new NotFoundException('Document not found');
    }
    if (!row.file_url || row.file_url === '#') {
      throw new NotFoundException('File not available');
    }

    const object = await this.documents.downloadObject(row.file_url);
    const safeDisposition = disposition === 'attachment' ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${safeDisposition}; filename="${row.name.replace(/"/g, "'")}"`,
    );
    res.setHeader('Content-Type', object.contentType || 'application/octet-stream');
    if (object.contentLength != null) {
      res.setHeader('Content-Length', object.contentLength);
    }
    object.body.pipe(res);
  }
}
