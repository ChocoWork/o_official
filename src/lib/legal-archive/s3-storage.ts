import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { ArchiveStorage } from './storage';

type S3Sender = Pick<S3Client, 'send'>;

export class S3ArchiveStorage implements ArchiveStorage {
  readonly name = 'external-s3';

  constructor(private readonly client: S3Sender, private readonly bucket: string) {}

  async putTemporary(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
    }));
  }

  async promote(temporaryKey: string, finalKey: string, immutable: boolean): Promise<void> {
    if (immutable && await this.exists(finalKey)) throw new Error('Immutable archive key exists');
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: finalKey,
      CopySource: `${this.bucket}/${encodeURIComponent(temporaryKey).replace(/%2F/g, '/')}`,
    }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NotFound') return false;
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error('S3 archive object has no body');
    return response.Body.transformToByteArray();
  }

  async removeTemporary(prefix: string): Promise<void> {
    const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }));
    for (const item of response.Contents ?? []) {
      if (item.Key) await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: item.Key }));
    }
  }
}

export function createS3ArchiveStorageFromEnv(
  environment: Record<string, string | undefined> = process.env,
): S3ArchiveStorage | null {
  const bucket = environment.S3_ARCHIVE_BUCKET;
  const region = environment.S3_ARCHIVE_REGION;
  if (!bucket && !region) return null;
  if (!bucket || !region) throw new Error('S3 archive bucket and region must both be configured');
  const config: S3ClientConfig = {
    region,
    endpoint: environment.S3_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: environment.S3_ARCHIVE_FORCE_PATH_STYLE === 'true',
  };
  return new S3ArchiveStorage(new S3Client(config), bucket);
}
