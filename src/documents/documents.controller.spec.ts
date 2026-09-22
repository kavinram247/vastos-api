import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { CallerContextService } from '../auth/caller-context.service';
import { DatabaseService } from '../db/database.service';
import { SupabaseService } from '../supabase/supabase.service';

type AuthedRequest = Request & { user: { id: string; email?: string } };

const REQ = {
  user: { id: 'auth-1', email: 'a@b.com' },
} as unknown as AuthedRequest;

const FILE = {
  buffer: Buffer.from('hello'),
  mimetype: 'application/pdf',
  originalname: 'a.pdf',
  size: 5,
} as Express.Multer.File;

function makeRes(): Response {
  return {
    setHeader: jest.fn(),
  } as unknown as Response;
}

type Row = Record<string, unknown> | null;

function makeDb(row: Row): DatabaseService {
  return {
    withServiceRole: (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: row ? [row] : [] }) }),
  } as unknown as DatabaseService;
}

async function build(
  callerContext: Partial<CallerContextService>,
  db: DatabaseService,
  documents: Partial<DocumentsService> = {},
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentsController],
    providers: [
      { provide: CallerContextService, useValue: callerContext },
      { provide: DatabaseService, useValue: db },
      // SupabaseAuthGuard (attached via @UseGuards) still needs this in the
      // DI graph to construct, even though these tests call controller
      // methods directly and never trigger the guard itself.
      { provide: SupabaseService, useValue: {} },
      {
        provide: DocumentsService,
        useValue: {
          buildObjectKey: () => 'firm-1/project-1/uuid',
          uploadObject: () => Promise.resolve(),
          downloadObject: () =>
            Promise.resolve({
              body: { pipe: jest.fn() },
              contentType: 'application/pdf',
              contentLength: 5,
            }),
          ...documents,
        },
      },
    ],
  }).compile();
  return moduleRef.get(DocumentsController);
}

describe('DocumentsController', () => {
  describe('upload', () => {
    it('403s when caller context is null (no matching profile)', async () => {
      const controller = await build(
        { resolve: () => Promise.resolve(null) },
        makeDb(null),
      );
      await expect(
        controller.upload('project-1', FILE, REQ),
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
              isAdmin: false,
            }),
        },
        makeDb({ id: 'project-1' }),
      );
      await expect(
        controller.upload('project-1', FILE, REQ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when no file is provided', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
              isAdmin: false,
            }),
        },
        makeDb({ id: 'project-1' }),
      );
      await expect(
        controller.upload('project-1', undefined as unknown as Express.Multer.File, REQ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the project is not found in the caller firm', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
              isAdmin: false,
            }),
        },
        makeDb(null),
      );
      await expect(
        controller.upload('project-1', FILE, REQ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uploads and returns the object key on the happy path', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
              isAdmin: false,
            }),
        },
        makeDb({ id: 'project-1' }),
      );
      const result = await controller.upload('project-1', FILE, REQ);
      expect(result).toEqual({ objectKey: 'firm-1/project-1/uuid', sizeBytes: 5 });
    });
  });

  describe('download', () => {
    it('404s when the document row is not found in the caller firm', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: false,
              isAdmin: false,
            }),
        },
        makeDb(null),
      );
      await expect(
        controller.download('doc-1', 'inline', REQ, makeRes()),
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
              isAdmin: false,
            }),
        },
        makeDb({
          file_url: 'firm-1/project-1/uuid',
          name: 'contract.pdf',
          visible_to_client: false,
        }),
      );
      await expect(
        controller.download('doc-1', 'inline', REQ, makeRes()),
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
              isAdmin: false,
            }),
        },
        makeDb({
          file_url: '#',
          name: 'legacy.pdf',
          visible_to_client: true,
        }),
      );
      await expect(
        controller.download('doc-1', 'inline', REQ, makeRes()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('streams the object and sets headers on the happy path', async () => {
      const controller = await build(
        {
          resolve: () =>
            Promise.resolve({
              firmId: 'firm-1',
              crmProfileId: 'cp1',
              isReadOnlyViewer: true,
              isAdmin: false,
            }),
        },
        makeDb({
          file_url: 'firm-1/project-1/uuid',
          name: 'contract.pdf',
          visible_to_client: true,
        }),
      );
      const res = makeRes();
      await controller.download('doc-1', 'attachment', REQ, res);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="contract.pdf"',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', 5);
    });
  });
});
