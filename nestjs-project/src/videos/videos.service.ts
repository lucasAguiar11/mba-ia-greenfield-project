import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { extname } from 'node:path';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  PRESIGNED_URL_EXPIRATION_SECONDS,
  StorageService,
} from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue.producer';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { Video, VideoMetadata } from './entities/video.entity';
import {
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exception';
import { deriveTitleFromFilename } from './title.util';

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024; // S3 multipart minimum part size (except the last part)

export interface UploadPartUrl {
  part_number: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  upload_id: string;
  part_urls: UploadPartUrl[];
}

export interface CompleteUploadResult {
  id: string;
  status: string;
}

export interface VideoDetail {
  id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  metadata: VideoMetadata | null;
  error_reason: string | null;
  created_at: Date;
}

export interface PresignedUrlResult {
  url: string;
  expires_at: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueProducer: VideoQueueProducer,
  ) {}

  async assertOwnership(video: Video, userId: string): Promise<void> {
    const isOwner = await this.channelsService.isOwnedByUser(
      video.channel_id,
      userId,
    );

    if (!isOwner) {
      throw new VideoNotOwnedException();
    }
  }

  async initiateUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channel.id,
        title: deriveTitleFromFilename(dto.filename),
        status: 'draft',
        storage_key_original: '',
      }),
    );

    const storageKey = `videos/${video.id}/original${extname(dto.filename)}`;
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    video.storage_key_original = storageKey;
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    const partCount = Math.max(
      1,
      Math.ceil(dto.size_bytes / MULTIPART_PART_SIZE_BYTES),
    );
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, index) => index + 1).map(
        async (partNumber): Promise<UploadPartUrl> => ({
          part_number: partNumber,
          url: await this.storageService.getUploadPartUrl(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    return { id: video.id, upload_id: uploadId, part_urls: partUrls };
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findVideoOrFail(videoId);
    await this.assertOwnership(video, userId);

    if (video.status !== 'draft') {
      throw new UploadAlreadyCompletedException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key_original,
      video.upload_id as string,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    video.status = 'processing';
    await this.videoRepository.save(video);

    await this.videoQueueProducer.enqueueVideoProcessing(video.id);

    return { id: video.id, status: video.status };
  }

  async getVideoDetail(videoId: string, userId: string): Promise<VideoDetail> {
    const video = await this.findVideoOrFail(videoId);
    await this.assertOwnership(video, userId);

    return {
      id: video.id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      error_reason: video.error_reason,
      created_at: video.created_at,
    };
  }

  async getStreamUrl(
    videoId: string,
    userId: string,
  ): Promise<PresignedUrlResult> {
    return this.getPresignedReadUrl(videoId, userId, { attachment: false });
  }

  async getDownloadUrl(
    videoId: string,
    userId: string,
  ): Promise<PresignedUrlResult> {
    return this.getPresignedReadUrl(videoId, userId, { attachment: true });
  }

  private async getPresignedReadUrl(
    videoId: string,
    userId: string,
    options: { attachment: boolean },
  ): Promise<PresignedUrlResult> {
    const video = await this.findVideoOrFail(videoId);
    await this.assertOwnership(video, userId);

    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    const url = await this.storageService.getPresignedGetUrl(
      video.storage_key_original,
      options,
    );

    return {
      url,
      expires_at: new Date(
        Date.now() + PRESIGNED_URL_EXPIRATION_SECONDS * 1000,
      ).toISOString(),
    };
  }

  private async findVideoOrFail(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
