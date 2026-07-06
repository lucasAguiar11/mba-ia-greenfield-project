import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE, VIDEO_QUEUE_JOBS } from './queue.constants';

export interface VideoProcessJobPayload {
  videoId: string;
}

const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_DELAY_MS = 5000;

@Injectable()
export class VideoQueueProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobPayload>,
  ) {}

  async enqueueVideoProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_QUEUE_JOBS.PROCESS,
      { videoId },
      {
        attempts: JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: JOB_BACKOFF_DELAY_MS,
        },
      },
    );
  }
}
