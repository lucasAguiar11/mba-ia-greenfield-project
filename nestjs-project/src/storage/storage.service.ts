import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export const PRESIGNED_URL_EXPIRATION_SECONDS = 900;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    this.internalClient = new S3Client({
      endpoint: config.internalEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });
    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.internalClient.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
    } catch {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async getUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const result = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    await pipeline(result.Body as Readable, createWriteStream(destinationPath));
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: await readFile(filePath),
        ContentType: contentType,
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    options: { attachment?: boolean } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.attachment && { ResponseContentDisposition: 'attachment' }),
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS,
    });
  }
}
