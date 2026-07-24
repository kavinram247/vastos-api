import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_EXPIRES_SECONDS = 600;
const DOWNLOAD_EXPIRES_SECONDS = 300;

@Injectable()
export class DocumentsService {
  private s3?: S3Client;
  private bucket?: string;

  constructor(private readonly config: ConfigService) {}

  // Lazy: constructing the S3Client eagerly would make R2 credentials
  // required just to boot the app (or run e2e tests unrelated to documents).
  private getClient(): { s3: S3Client; bucket: string } {
    if (!this.s3) {
      this.bucket = this.config.getOrThrow<string>('R2_BUCKET_NAME');
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${this.config.getOrThrow<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
          secretAccessKey: this.config.getOrThrow<string>(
            'R2_SECRET_ACCESS_KEY',
          ),
        },
        // Recent AWS SDK v3 defaults add checksum headers a plain browser
        // fetch(PUT) won't echo back, which breaks presigned-URL signature
        // verification against R2 (and other S3-compatible, non-AWS endpoints).
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    }
    return { s3: this.s3, bucket: this.bucket! };
  }

  // No filename in the key: avoids sanitizing arbitrary user filenames for no
  // benefit, since the human-readable name is already stored separately in
  // crm_project_documents.name.
  buildObjectKey(firmId: string, projectId: string): string {
    return `${firmId}/${projectId}/${randomUUID()}`;
  }

  async presignUpload(key: string, contentType: string): Promise<string> {
    const { s3, bucket } = this.getClient();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(s3, command, {
      expiresIn: UPLOAD_EXPIRES_SECONDS,
    });
  }

  async presignDownload(
    key: string,
    filename: string,
    disposition: 'inline' | 'attachment',
  ): Promise<string> {
    const { s3, bucket } = this.getClient();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `${disposition}; filename="${filename.replace(/"/g, "'")}"`,
    });
    return getSignedUrl(s3, command, {
      expiresIn: DOWNLOAD_EXPIRES_SECONDS,
    });
  }
}
