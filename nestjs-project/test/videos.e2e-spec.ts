import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import storageConfig from '../src/config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { Video } from '../src/videos/entities/video.entity';

interface ResponseBody {
  id?: string;
  upload_id?: string;
  status?: string;
  error?: string;
  access_token?: string;
  part_urls?: { part_number: number; url: string }[];
  title?: string;
  duration_seconds?: number | null;
  metadata?: Record<string, unknown> | null;
  error_reason?: string | null;
  created_at?: string;
  url?: string;
  expires_at?: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Pausing is global (affects any worker on this queue, including the
    // real video-worker container) — without it, a live worker races these
    // assertions and consumes the job before we can inspect it.
    await queue.pause();
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await queue.resume();
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as ResponseBody).access_token as string;
  }

  function validUploadPayload() {
    return {
      filename: 'My Trip - Summer.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
    };
  }

  async function initiateUpload(
    token: string,
  ): Promise<{ id: string; uploadId: string; storageKey: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validUploadPayload())
      .expect(201);

    const body = res.body as ResponseBody;
    const video = await videoRepository.findOneByOrFail({ id: body.id });
    return {
      id: body.id as string,
      uploadId: body.upload_id as string,
      storageKey: video.storage_key_original,
    };
  }

  async function uploadRealPart(
    storageKey: string,
    uploadId: string,
  ): Promise<string> {
    const config = storageConfig();
    const client = new S3Client({
      endpoint: config.internalEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    const result = await client.send(
      new UploadPartCommand({
        Bucket: config.bucket,
        Key: storageKey,
        UploadId: uploadId,
        PartNumber: 1,
        Body: 'e2e test part content',
      }),
    );
    return result.ETag as string;
  }

  async function markVideoReady(id: string): Promise<void> {
    await videoRepository.update(id, { status: 'ready' });
  }

  describe('POST /videos', () => {
    it('creates a draft video and returns one part_url per part for an authenticated owner', async () => {
      const token = await registerConfirmAndLogin('owner1@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validUploadPayload())
        .expect(201);

      const body = res.body as ResponseBody;
      expect(body.id).toBeDefined();
      expect(body.upload_id).toBeDefined();
      expect(body.part_urls).toHaveLength(1);
      expect(body.part_urls![0]).toEqual(
        expect.objectContaining({ part_number: 1 }),
      );

      const video = await videoRepository.findOneByOrFail({ id: body.id });
      expect(video.status).toBe('draft');
      expect(video.title).toBe('My Trip - Summer');
    });

    it('returns 400 for an invalid payload', async () => {
      const token = await registerConfirmAndLogin('owner2@example.com');

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ content_type: 'video/mp4', size_bytes: 1024 })
        .expect(400);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validUploadPayload())
        .expect(401);
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('moves the video to processing and enqueues the processing job for the owner', async () => {
      const token = await registerConfirmAndLogin('owner3@example.com');
      const { id, uploadId, storageKey } = await initiateUpload(token);
      const etag = await uploadRealPart(storageKey, uploadId);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const body = res.body as ResponseBody;
      expect(body).toEqual({ id, status: 'processing' });

      const video = await videoRepository.findOneByOrFail({ id });
      expect(video.status).toBe('processing');

      const jobs = await queue.getJobs(['waiting', 'delayed']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId: id });
    });

    it('returns 403 when the caller does not own the video', async () => {
      const ownerToken = await registerConfirmAndLogin('owner4@example.com');
      const otherToken = await registerConfirmAndLogin('other4@example.com');
      const { id, uploadId, storageKey } = await initiateUpload(ownerToken);
      const etag = await uploadRealPart(storageKey, uploadId);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(403);

      expect((res.body as ResponseBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 409 when the upload was already completed', async () => {
      const token = await registerConfirmAndLogin('owner5@example.com');
      const { id, uploadId, storageKey } = await initiateUpload(token);
      const etag = await uploadRealPart(storageKey, uploadId);

      await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(409);

      expect((res.body as ResponseBody).error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .send({ parts: [{ part_number: 1, etag: 'irrelevant' }] })
        .expect(401);
    });
  });

  describe('GET /videos/:id', () => {
    it("returns the video's fields for the owner", async () => {
      const token = await registerConfirmAndLogin('owner6@example.com');
      const { id } = await initiateUpload(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as ResponseBody;
      expect(body.id).toBe(id);
      expect(body.title).toBe('My Trip - Summer');
      expect(body.status).toBe('draft');
      expect(body).toHaveProperty('duration_seconds');
      expect(body).toHaveProperty('metadata');
      expect(body).toHaveProperty('error_reason');
      expect(body).toHaveProperty('created_at');
    });
  });

  describe('GET /videos/:id/stream and GET /videos/:id/download', () => {
    it('return a presigned URL and expires_at when the video is ready', async () => {
      const token = await registerConfirmAndLogin('owner7@example.com');
      const { id } = await initiateUpload(token);
      await markVideoReady(id);

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((streamRes.body as ResponseBody).url).toBeDefined();
      expect((streamRes.body as ResponseBody).expires_at).toBeDefined();

      const downloadRes = await request(app.getHttpServer())
        .get(`/videos/${id}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((downloadRes.body as ResponseBody).url).toBeDefined();
      expect((downloadRes.body as ResponseBody).expires_at).toBeDefined();
    });

    it('return 409 VIDEO_NOT_READY when the video is not ready', async () => {
      const token = await registerConfirmAndLogin('owner8@example.com');
      const { id } = await initiateUpload(token); // status stays draft

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((streamRes.body as ResponseBody).error).toBe('VIDEO_NOT_READY');

      const downloadRes = await request(app.getHttpServer())
        .get(`/videos/${id}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((downloadRes.body as ResponseBody).error).toBe('VIDEO_NOT_READY');
    });

    it('return 403 for a non-owner and 401 without authentication, across all three read endpoints', async () => {
      const ownerToken = await registerConfirmAndLogin('owner9@example.com');
      const otherToken = await registerConfirmAndLogin('other9@example.com');
      const { id } = await initiateUpload(ownerToken);
      await markVideoReady(id);

      for (const path of [
        `/videos/${id}`,
        `/videos/${id}/stream`,
        `/videos/${id}/download`,
      ]) {
        const forbidden = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${otherToken}`)
          .expect(403);
        expect((forbidden.body as ResponseBody).error).toBe('VIDEO_NOT_OWNED');

        await request(app.getHttpServer()).get(path).expect(401);
      }
    });
  });
});
