import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { VideoProcessJobPayload } from '../queue/video-queue.producer';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import {
  generateThumbnail,
  probeVideo,
  type ProbedMetadata,
} from './ffmpeg.util';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

function extensionOf(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot >= 0 ? key.slice(dot) : '';
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobPayload>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneByOrFail({
      id: videoId,
    });

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const originalPath = join(
      workDir,
      `original${extensionOf(video.storage_key_original)}`,
    );
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      // Transient infra failures below (storage unreachable) are left to
      // propagate — BullMQ retries per phase-03-videos/TD-01's backoff policy.
      await this.storageService.downloadToFile(
        video.storage_key_original,
        originalPath,
      );

      let metadata: ProbedMetadata;
      try {
        // Deterministic media failures (corrupted file) are terminal — retrying
        // won't fix a bad file, so this is mapped to status=error directly and
        // the job completes normally (no BullMQ retry).
        metadata = await probeVideo(originalPath);
        await generateThumbnail(originalPath, thumbnailPath);
      } catch (err) {
        await this.markAsError(video, err as Error);
        return;
      }

      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.uploadFile(
        thumbnailKey,
        thumbnailPath,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.status = 'ready';
      video.duration_seconds = metadata.durationSeconds;
      video.metadata = {
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        bitrate: metadata.bitrate,
      };
      video.storage_key_thumbnail = thumbnailKey;
      await this.videoRepository.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobPayload> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return; // more retries pending — leave status as processing
    }

    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (video && video.status !== 'ready') {
      await this.markAsError(video, error);
    }
  }

  private async markAsError(video: Video, error: Error): Promise<void> {
    video.status = 'error';
    video.error_reason = error.message;
    await this.videoRepository.save(video);
  }
}
