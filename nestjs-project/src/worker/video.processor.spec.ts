import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { Job } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { VideoProcessJobPayload } from '../queue/video-queue.producer';
import { Video, VideoMetadata } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

jest.mock('node:child_process');

function objectContaining<T extends object>(obj: Partial<T>): T {
  return expect.objectContaining(obj) as unknown as T;
}

function stringContaining(substring: string): string {
  return expect.stringContaining(substring) as unknown as string;
}

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

type SpawnResponse = { stdout?: string; stderr?: string; code?: number };

function mockSpawn(responses: Record<string, SpawnResponse>): void {
  (childProcess.spawn as jest.Mock).mockImplementation(
    (command: string, args: string[]) => {
      const child = new EventEmitter() as FakeChildProcess;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const response = responses[command] ?? { code: 0 };
      process.nextTick(() => {
        // generateThumbnail verifies the output file (last arg) actually
        // exists after ffmpeg exits — fake a real one for the success path.
        if (command === 'ffmpeg' && (response.code ?? 0) === 0) {
          writeFileSync(args[args.length - 1], 'fake-thumbnail-bytes');
        }
        if (response.stdout) {
          child.stdout.emit('data', Buffer.from(response.stdout));
        }
        if (response.stderr) {
          child.stderr.emit('data', Buffer.from(response.stderr));
        }
        child.emit('close', response.code ?? 0);
      });
      return child as unknown as childProcess.ChildProcess;
    },
  );
}

const FFPROBE_JSON = JSON.stringify({
  format: { duration: '12.5', bit_rate: '900000' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      bit_rate: '850000',
    },
  ],
});

type MockRepository = {
  findOneByOrFail: jest.Mock;
  findOneBy: jest.Mock;
  save: jest.Mock;
};

type MockStorageService = {
  downloadToFile: jest.Mock;
  uploadFile: jest.Mock;
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.channel_id = 'channel-1';
  video.status = 'processing';
  video.storage_key_original = 'videos/video-id/original.mp4';
  return Object.assign(video, overrides);
}

function makeProcessor(overrides: {
  videoRepository?: Partial<MockRepository>;
  storageService?: Partial<MockStorageService>;
}) {
  const videoRepository: MockRepository = {
    findOneByOrFail: jest.fn().mockResolvedValue(makeVideo()),
    findOneBy: jest.fn().mockResolvedValue(makeVideo()),
    save: jest.fn((video: Video) => Promise.resolve(video)),
    ...overrides.videoRepository,
  };
  const storageService: MockStorageService = {
    downloadToFile: jest.fn().mockResolvedValue(undefined),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    ...overrides.storageService,
  };

  const processor = new VideoProcessor(
    videoRepository as unknown as ConstructorParameters<
      typeof VideoProcessor
    >[0],
    storageService as unknown as StorageService,
  );

  return { processor, videoRepository, storageService };
}

function makeJob(
  overrides: Partial<Job<VideoProcessJobPayload>> = {},
): Job<VideoProcessJobPayload> {
  return {
    data: { videoId: 'video-id' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job<VideoProcessJobPayload>;
}

describe('VideoProcessor', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('process', () => {
    it('extracts metadata, generates a thumbnail, and marks the video ready', async () => {
      mockSpawn({ ffprobe: { stdout: FFPROBE_JSON }, ffmpeg: {} });
      const { processor, videoRepository, storageService } = makeProcessor({});

      await processor.process(makeJob());

      expect(storageService.downloadToFile).toHaveBeenCalledWith(
        'videos/video-id/original.mp4',
        expect.stringContaining('original.mp4'),
      );
      expect(storageService.uploadFile).toHaveBeenCalledWith(
        'videos/video-id/thumbnail.jpg',
        expect.stringContaining('thumbnail.jpg'),
        'image/jpeg',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          duration_seconds: 13,
          storage_key_thumbnail: 'videos/video-id/thumbnail.jpg',
          metadata: objectContaining<VideoMetadata>({
            width: 1920,
            height: 1080,
            codec: 'h264',
          }),
        }),
      );
    });

    it('marks the video as error without throwing when ffprobe fails on a corrupted file', async () => {
      mockSpawn({
        ffprobe: { stderr: 'Invalid data found', code: 1 },
      });
      const { processor, videoRepository, storageService } = makeProcessor({});

      await expect(processor.process(makeJob())).resolves.toBeUndefined();

      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error_reason: stringContaining('ffprobe exited with code 1'),
        }),
      );
      expect(storageService.uploadFile).not.toHaveBeenCalled();
    });

    it('propagates transient storage failures instead of marking the video as error', async () => {
      const { processor, videoRepository, storageService } = makeProcessor({
        storageService: {
          downloadToFile: jest
            .fn()
            .mockRejectedValue(new Error('MinIO unreachable')),
        },
      });

      await expect(processor.process(makeJob())).rejects.toThrow(
        'MinIO unreachable',
      );
      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storageService.uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('does not touch the video when more retry attempts remain', async () => {
      const { processor, videoRepository } = makeProcessor({});

      await processor.onFailed(
        makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
        new Error('transient'),
      );

      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('marks the video as error once retries are exhausted', async () => {
      const { processor, videoRepository } = makeProcessor({
        videoRepository: {
          findOneBy: jest.fn().mockResolvedValue(makeVideo()),
        },
      });

      await processor.onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('storage still unreachable'),
      );

      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error_reason: 'storage still unreachable',
        }),
      );
    });
  });
});
