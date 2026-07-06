import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Job } from 'bullmq';
import { Channel } from '../channels/entities/channel.entity';
import { VideoProcessJobPayload } from '../queue/video-queue.producer';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

async function generateSyntheticVideo(outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=64x64:rate=5',
      '-pix_fmt',
      'yuv420p',
      outputPath,
    ]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg generation failed: ${stderr}`));
    });
  });
}

describe('VideoProcessor (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let processor: VideoProcessor;
  let internalClient: S3Client;
  let bucket: string;
  let workDir: string;
  let channelId: string;
  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [databaseConfig.KEY],
          useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: dbConfig.host,
            port: dbConfig.port,
            username: dbConfig.username,
            password: dbConfig.password,
            database: dbConfig.name,
            entities: [User, Channel, Video],
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([User, Channel, Video]),
        StorageModule,
      ],
      providers: [VideoProcessor],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    processor = moduleFixture.get(VideoProcessor);

    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: 'video-processor-fixture@example.com',
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Fixture',
        nickname: 'vpfixture',
        user_id: user.id,
      }),
    );
    channelId = channel.id;

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

    workDir = await mkdtemp(join(tmpdir(), 'video-processor-fixtures-'));
  }, 60000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await cleanAllTables(dataSource);
    await app.close();
  });

  async function createVideoRow(storageKeyOriginal: string): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: `Test video ${++counter}`,
        status: 'processing',
        storage_key_original: storageKeyOriginal,
      }),
    );
  }

  function makeJob(videoId: string): Job<VideoProcessJobPayload> {
    return {
      data: { videoId },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as unknown as Job<VideoProcessJobPayload>;
  }

  it('processes a valid video: extracts metadata and uploads a real thumbnail', async () => {
    const localPath = join(workDir, `valid-${++counter}.mp4`);
    await generateSyntheticVideo(localPath);

    const storageKey = `videos/test-${Date.now()}-${counter}/original.mp4`;
    await storageService.uploadFile(storageKey, localPath, 'video/mp4');
    const video = await createVideoRow(storageKey);

    await processor.process(makeJob(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe('ready');
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(updated.storage_key_thumbnail).toBe(
      `videos/${video.id}/thumbnail.jpg`,
    );
    expect(updated.metadata).toEqual(
      expect.objectContaining({ width: 64, height: 64 }),
    );

    const head = await internalClient.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: updated.storage_key_thumbnail as string,
      }),
    );
    expect(head.ContentLength).toBeGreaterThan(0);
  }, 30000);

  it('marks the video as error when the file is corrupted, without throwing', async () => {
    const storageKey = `videos/test-${Date.now()}-${++counter}/original.mp4`;
    await internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: Buffer.from('this is not a real video file'),
        ContentType: 'video/mp4',
      }),
    );
    const video = await createVideoRow(storageKey);

    await expect(processor.process(makeJob(video.id))).resolves.toBeUndefined();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe('error');
    expect(updated.error_reason).toBeTruthy();
  }, 30000);
});
