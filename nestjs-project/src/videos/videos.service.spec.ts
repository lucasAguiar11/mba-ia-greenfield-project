import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue.producer';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { Video } from './entities/video.entity';
import {
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exception';
import { VideosService } from './videos.service';

type MockRepository = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
};

type MockChannelsService = {
  isOwnedByUser: jest.Mock;
  findByUserId: jest.Mock;
};

type MockStorageService = {
  createMultipartUpload: jest.Mock;
  getUploadPartUrl: jest.Mock;
  completeMultipartUpload: jest.Mock;
  getPresignedGetUrl: jest.Mock;
};

type MockQueueProducer = {
  enqueueVideoProcessing: jest.Mock;
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.channel_id = 'channel-1';
  video.status = 'draft';
  video.storage_key_original = 'videos/video-id/original.mp4';
  video.upload_id = 'upload-id';
  return Object.assign(video, overrides);
}

function makeService(overrides: {
  videoRepository?: Partial<MockRepository>;
  channelsService?: Partial<MockChannelsService>;
  storageService?: Partial<MockStorageService>;
  queueProducer?: Partial<MockQueueProducer>;
}) {
  const videoRepository: MockRepository = {
    create: jest.fn((data: Partial<Video>) => data as Video),
    save: jest.fn((video: Video) => Promise.resolve(video)),
    findOne: jest.fn(),
    ...overrides.videoRepository,
  };
  const channelsService: MockChannelsService = {
    isOwnedByUser: jest.fn().mockResolvedValue(true),
    findByUserId: jest.fn(),
    ...overrides.channelsService,
  };
  const storageService: MockStorageService = {
    createMultipartUpload: jest.fn(),
    getUploadPartUrl: jest.fn(),
    completeMultipartUpload: jest.fn(),
    getPresignedGetUrl: jest.fn().mockResolvedValue('https://signed-get-url'),
    ...overrides.storageService,
  };
  const queueProducer: MockQueueProducer = {
    enqueueVideoProcessing: jest.fn(),
    ...overrides.queueProducer,
  };

  const service = new VideosService(
    videoRepository as unknown as VideosServiceCtorArgs[0],
    channelsService as unknown as ChannelsService,
    storageService as unknown as StorageService,
    queueProducer as unknown as VideoQueueProducer,
  );

  return {
    service,
    videoRepository,
    channelsService,
    storageService,
    queueProducer,
  };
}

type VideosServiceCtorArgs = ConstructorParameters<typeof VideosService>;

describe('VideosService', () => {
  describe('assertOwnership', () => {
    it('does not throw when the video belongs to the authenticated user', async () => {
      const { service, channelsService } = makeService({
        channelsService: { isOwnedByUser: jest.fn().mockResolvedValue(true) },
      });
      const video = makeVideo({ channel_id: 'channel-1' });

      await expect(
        service.assertOwnership(video, 'user-1'),
      ).resolves.toBeUndefined();
      expect(channelsService.isOwnedByUser).toHaveBeenCalledWith(
        'channel-1',
        'user-1',
      );
    });

    it('throws VideoNotOwnedException when the video belongs to another channel', async () => {
      const { service } = makeService({
        channelsService: { isOwnedByUser: jest.fn().mockResolvedValue(false) },
      });
      const video = makeVideo({ channel_id: 'channel-2' });

      await expect(service.assertOwnership(video, 'user-1')).rejects.toThrow(
        VideoNotOwnedException,
      );
    });
  });

  describe('initiateUpload', () => {
    const dto: CreateVideoUploadDto = {
      filename: 'My Trip - Summer.mp4',
      content_type: 'video/mp4',
      size_bytes: 12 * 1024 * 1024, // 12MB → 3 parts at 5MB each
    };

    it('creates a draft video with a title derived from the filename', async () => {
      const channel = { id: 'channel-1' } as Channel;
      const { service, videoRepository } = makeService({
        channelsService: { findByUserId: jest.fn().mockResolvedValue(channel) },
        storageService: {
          createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
          getUploadPartUrl: jest.fn().mockResolvedValue('https://signed-url'),
        },
      });

      await service.initiateUpload('user-1', dto);

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          title: 'My Trip - Summer',
          status: 'draft',
        }),
      );
    });

    it('computes one part_url per part derived from size_bytes', async () => {
      const channel = { id: 'channel-1' } as Channel;
      const { service } = makeService({
        channelsService: { findByUserId: jest.fn().mockResolvedValue(channel) },
        storageService: {
          createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
          getUploadPartUrl: jest.fn().mockResolvedValue('https://signed-url'),
        },
      });

      const result = await service.initiateUpload('user-1', dto);

      expect(result.upload_id).toBe('upload-id');
      expect(result.part_urls).toHaveLength(3);
      expect(result.part_urls.map((p) => p.part_number)).toEqual([1, 2, 3]);
    });

    it('always computes at least one part for small files', async () => {
      const channel = { id: 'channel-1' } as Channel;
      const { service } = makeService({
        channelsService: { findByUserId: jest.fn().mockResolvedValue(channel) },
        storageService: {
          createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
          getUploadPartUrl: jest.fn().mockResolvedValue('https://signed-url'),
        },
      });

      const result = await service.initiateUpload('user-1', {
        ...dto,
        size_bytes: 100,
      });

      expect(result.part_urls).toHaveLength(1);
    });
  });

  describe('completeUpload', () => {
    const dto: CompleteVideoUploadDto = {
      parts: [{ part_number: 1, etag: 'etag-1' }],
    };

    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = makeService({
        videoRepository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.completeUpload('missing-id', 'user-1', dto),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when the caller does not own the video', async () => {
      const { service } = makeService({
        videoRepository: { findOne: jest.fn().mockResolvedValue(makeVideo()) },
        channelsService: { isOwnedByUser: jest.fn().mockResolvedValue(false) },
      });

      await expect(
        service.completeUpload('video-id', 'user-1', dto),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('throws UploadAlreadyCompletedException when the video is not a draft anymore', async () => {
      const { service } = makeService({
        videoRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: 'processing' })),
        },
      });

      await expect(
        service.completeUpload('video-id', 'user-1', dto),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });

    it('completes the upload, moves the video to processing, and enqueues the job', async () => {
      const { service, storageService, queueProducer, videoRepository } =
        makeService({
          videoRepository: {
            findOne: jest.fn().mockResolvedValue(makeVideo()),
          },
        });

      const result = await service.completeUpload('video-id', 'user-1', dto);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original.mp4',
        'upload-id',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'processing' }),
      );
      expect(queueProducer.enqueueVideoProcessing).toHaveBeenCalledWith(
        'video-id',
      );
      expect(result).toEqual({ id: 'video-id', status: 'processing' });
    });
  });

  describe('getVideoDetail', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = makeService({
        videoRepository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.getVideoDetail('missing-id', 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when the caller does not own the video', async () => {
      const { service } = makeService({
        videoRepository: { findOne: jest.fn().mockResolvedValue(makeVideo()) },
        channelsService: { isOwnedByUser: jest.fn().mockResolvedValue(false) },
      });

      await expect(
        service.getVideoDetail('video-id', 'user-1'),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('returns the video fields for the owner', async () => {
      const { service } = makeService({
        videoRepository: {
          findOne: jest.fn().mockResolvedValue(
            makeVideo({
              status: 'ready',
              duration_seconds: 42,
              metadata: { width: 1920, height: 1080 },
            }),
          ),
        },
      });

      const result = await service.getVideoDetail('video-id', 'user-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'video-id',
          status: 'ready',
          duration_seconds: 42,
          metadata: { width: 1920, height: 1080 },
        }),
      );
    });
  });

  describe.each([
    ['getStreamUrl', false],
    ['getDownloadUrl', true],
  ] as const)('%s', (methodName, attachment) => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = makeService({
        videoRepository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(service[methodName]('missing-id', 'user-1')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotOwnedException when the caller does not own the video', async () => {
      const { service } = makeService({
        videoRepository: {
          findOne: jest.fn().mockResolvedValue(makeVideo({ status: 'ready' })),
        },
        channelsService: { isOwnedByUser: jest.fn().mockResolvedValue(false) },
      });

      await expect(service[methodName]('video-id', 'user-1')).rejects.toThrow(
        VideoNotOwnedException,
      );
    });

    it('throws VideoNotReadyException when the video is not ready', async () => {
      const { service } = makeService({
        videoRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: 'processing' })),
        },
      });

      await expect(service[methodName]('video-id', 'user-1')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('returns a presigned URL with the correct disposition and an expires_at', async () => {
      const { service, storageService } = makeService({
        videoRepository: {
          findOne: jest.fn().mockResolvedValue(makeVideo({ status: 'ready' })),
        },
      });

      const result = await service[methodName]('video-id', 'user-1');

      expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        'videos/video-id/original.mp4',
        { attachment },
      );
      expect(result.url).toBe('https://signed-get-url');
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });
});
