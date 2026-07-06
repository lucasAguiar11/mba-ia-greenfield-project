import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// Object storage is only reachable from inside this container via the internal
// endpoint (`minio:9000`). The public endpoint (`localhost:9000`) that presigned
// URLs point to is meant for the browser/host, not for code running in this
// container — see root CLAUDE.md's Docker Networking note. So the real
// upload-a-byte round trip below talks to MinIO via a plain S3Client pointed at
// the internal endpoint (mirroring what StorageService itself does for its own
// control-plane calls); the presigned URLs from StorageService are verified
// structurally instead of by fetching them.
describe('StorageService (integration)', () => {
  let app: INestApplication;
  let storageService: StorageService;
  let internalClient: S3Client;
  let bucket: string;
  let keyCounter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    storageService = app.get(StorageService);

    const config = storageConfig();
    bucket = config.bucket;
    internalClient = new S3Client({
      endpoint: config.internalEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  function nextKey(): string {
    return `videos/test-${Date.now()}-${++keyCounter}/original.txt`;
  }

  it('should return a valid UploadId recognized by the storage backend', async () => {
    const key = nextKey();

    const uploadId = await storageService.createMultipartUpload(
      key,
      'text/plain',
    );

    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);
  });

  it('should complete a multipart upload with a single part and make the object retrievable', async () => {
    const key = nextKey();
    const content = 'hello from the storage integration test';

    const uploadId = await storageService.createMultipartUpload(
      key,
      'text/plain',
    );
    const uploadPartResult = await internalClient.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: content,
      }),
    );

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: uploadPartResult.ETag as string },
    ]);

    const head = await internalClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    expect(head.ContentLength).toBe(Buffer.byteLength(content));
  });

  it('should set attachment disposition on the presigned GET URL when requested', async () => {
    const url = await storageService.getPresignedGetUrl('videos/anything.txt', {
      attachment: true,
    });

    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('response-content-disposition=attachment');
  });

  it('should sign presigned URLs against the public endpoint, not the internal one', async () => {
    const getUrl = await storageService.getPresignedGetUrl(
      'videos/anything.txt',
    );
    const partUrl = await storageService.getUploadPartUrl(
      'videos/anything.txt',
      'fake-upload-id',
      1,
    );

    for (const url of [getUrl, partUrl]) {
      expect(url).toContain('localhost:9000');
      expect(url).not.toContain('minio:9000');
    }
  });
});
