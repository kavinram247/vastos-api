import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { CallerContextService } from '../auth/caller-context.service';
import { SupabaseService } from '../supabase/supabase.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

const REQ = {
  user: { id: 'auth-1', email: 'a@b.com' },
} as unknown as AuthedRequest;

type Row = Record<string, unknown> | null;

interface MockQuery {
  select: (columns: string) => MockQuery;
  eq: (column: string, value: string) => MockQuery;
  maybeSingle: () => Promise<{ data: Row; error: null }>;
}

function makeSupabase(row: Row): SupabaseService {
  const query: MockQuery = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return {
    getServiceRoleClient: () => ({ from: () => query }),
  } as unknown as SupabaseService;
}

async function build(
  callerContext: Partial<CallerContextService>,
  supabase: SupabaseService,
  documents: Partial<DocumentsService> = {},
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentsController],
    providers: [
      { provide: CallerContextService, useValue: callerContext },
      { provide: SupabaseService, useValue: supabase },
      {
        provide: DocumentsService,
        useValue: {
          buildObjectKey: () => 'firm-1/project-1/uuid',
          presignUpload: () => Promise.resolve('https://r2.example/upload'),
          presignDownload: () => Promise.resolve('https://r2.example/download'),
          ...documents,
        },
      },
    ],
  }).compile();
  return moduleRef.get(DocumentsController);
}

describe('DocumentsController', () => {
  describe('presignUpload', () => {
    it('403s when caller context is null (no matching profile)', async () => {
      const controller = await build(
        { resolve: () => Promise.resolve(null) },
        makeSupabase(null),
      );
      await expect(
        controller.presignUpload(
          'project-1',
          { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
          REQ,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s a read-only viewer', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: true,
            }),
        },
        makeSupabase({ id: 'project-1' }),
      );
      await expect(
        controller.presignUpload(
          'project-1',
          { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
          REQ,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the project is not found in the caller firm', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
            }),
        },
        makeSupabase(null),
      );
      await expect(
        controller.presignUpload(
          'project-1',
          { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
          REQ,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a presigned URL on the happy path', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
            }),
        },
        makeSupabase({ id: 'project-1' }),
      );
      const result = await controller.presignUpload(
        'project-1',
        { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
        REQ,
      );
      expect(result).toEqual({
        uploadUrl: 'https://r2.example/upload',
        objectKey: 'firm-1/project-1/uuid',
        expiresIn: 600,
      });
    });
  });

  describe('presignDownload', () => {
    it('404s when the document row is not found in the caller firm', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
            }),
        },
        makeSupabase(null),
      );
      await expect(
        controller.presignDownload('doc-1', 'inline', REQ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s (not 403) when a read-only viewer requests a non-client-visible document', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: true,
            }),
        },
        makeSupabase({
          file_url: 'firm-1/project-1/uuid',
          name: 'contract.pdf',
          visible_to_client: false,
        }),
      );
      await expect(
        controller.presignDownload('doc-1', 'inline', REQ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s legacy rows with the mocked file_url placeholder', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
            }),
        },
        makeSupabase({
          file_url: '#',
          name: 'legacy.pdf',
          visible_to_client: true,
        }),
      );
      await expect(
        controller.presignDownload('doc-1', 'inline', REQ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a presigned URL on the happy path for a visible document', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: true,
            }),
        },
        makeSupabase({
          file_url: 'firm-1/project-1/uuid',
          name: 'contract.pdf',
          visible_to_client: true,
        }),
      );
      const result = await controller.presignDownload(
        'doc-1',
        'attachment',
        REQ,
      );
      expect(result).toEqual({
        downloadUrl: 'https://r2.example/download',
        expiresIn: 300,
      });
    });
  });
});
