import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface DownloadedObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

/**
 * Self-hosted MinIO (Kamal accessory `vastos-api-minio`, private to the
 * `kamal` Docker network — bound to 127.0.0.1 on the host, never public).
 * Replaces Cloudflare R2 (Phase 5, item 3.8). Because MinIO has no public
 * endpoint, there is no presigned-URL path for the browser to use directly
 * (that's what R2 gave us) — every upload/download now proxies through this
 * service instead, over the private network vastos-api already reaches
 * Postgres on.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);
  private s3?: S3Client;
  private bucket?: string;

  constructor(private readonly config: ConfigService) {}

  // Lazy: constructing the S3Client eagerly would make MinIO credentials
  // required just to boot the app (or run e2e tests unrelated to documents).
  private getClient(): { s3: S3Client; bucket: string } {
    if (!this.s3) {
      this.bucket = this.config.getOrThrow<string>('MINIO_BUCKET_NAME');
      this.s3 = new S3Client({
        region: 'us-east-1', // MinIO ignores this; the SDK requires some value.
        endpoint: this.config.getOrThrow<string>('MINIO_ENDPOINT'),
        // MinIO doesn't do virtual-hosted-style (bucket.host/key) routing —
        // path-style (host/bucket/key) is required.
        forcePathStyle: true,
        credentials: {
          accessKeyId: this.config.getOrThrow<string>('MINIO_ROOT_USER'),
          secretAccessKey: this.config.getOrThrow<string>(
            'MINIO_ROOT_PASSWORD',
          ),
        },
      });
    }
    return { s3: this.s3, bucket: this.bucket! };
  }

  // Self-healing: MinIO doesn't auto-create buckets, and this project's own
  // accessory has no console (MINIO_BROWSER=off) to click one into existence.
  // Runs on every boot; a bucket that already exists is a no-op, not an error.
  async onModuleInit() {
    if (!this.config.get<string>('MINIO_ENDPOINT')) {
      this.logger.warn(
        'MINIO_ENDPOINT is not set — document upload/download will 503',
      );
      return;
    }
    const { s3, bucket } = this.getClient();
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`created MinIO bucket ${bucket}`);
    } catch (err: any) {
      const code = err?.name ?? err?.Code;
      if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists') {
        return;
      }
      this.logger.error(`could not ensure MinIO bucket ${bucket}: ${err?.message}`);
    }
  }

  // No filename in the key: avoids sanitizing arbitrary user filenames for no
  // benefit, since the human-readable name is already stored separately in
  // crm_project_documents.name.
  buildObjectKey(firmId: string, projectId: string): string {
    return `${firmId}/${projectId}/${randomUUID()}`;
  }

  async uploadObject(
    key: string,
    contentType: string,
    body: Buffer,
  ): Promise<void> {
    const { s3, bucket } = this.getClient();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async downloadObject(key: string): Promise<DownloadedObject> {
    const { s3, bucket } = this.getClient();
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      body: result.Body as Readable,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
    };
  }
}
