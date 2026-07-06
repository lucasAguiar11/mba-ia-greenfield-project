import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { VideoQueueProducer } from './video-queue.producer';

@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoQueueProducer],
  exports: [VideoQueueProducer],
})
export class QueueModule {}
