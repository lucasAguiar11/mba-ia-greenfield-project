import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE, VIDEO_QUEUE_JOBS } from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueProducer } from './video-queue.producer';

describe('VideoQueueProducer (integration)', () => {
  let app: INestApplication;
  let producer: VideoQueueProducer;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        QueueModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    producer = app.get(VideoQueueProducer);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Pausing is global (affects any worker on this queue, including the
    // real video-worker container) — without it, a live worker races these
    // assertions and consumes the job before we can inspect it.
    await queue.pause();
  }, 30000);

  afterAll(async () => {
    await queue.resume();
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await queue.drain(true);
  });

  it('should enqueue a job named video.process with the { videoId } payload', async () => {
    await producer.enqueueVideoProcessing('video-123');

    const jobs = await queue.getJobs(['waiting', 'delayed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(VIDEO_QUEUE_JOBS.PROCESS);
    expect(jobs[0].data).toEqual({ videoId: 'video-123' });
  });

  it('should configure exponential backoff retries, not a single attempt', async () => {
    await producer.enqueueVideoProcessing('video-456');

    const [job] = await queue.getJobs(['waiting', 'delayed']);
    expect(job.opts.attempts).toBeGreaterThan(1);
    expect(job.opts.backoff).toEqual(
      expect.objectContaining({ type: 'exponential' }),
    );
  });
});
