import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export type VideoStatus = 'draft' | 'processing' | 'ready' | 'error';

export interface VideoMetadata {
  width?: number;
  height?: number;
  codec?: string;
  bitrate?: number;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({
    type: 'enum',
    enum: ['draft', 'processing', 'ready', 'error'],
    default: 'draft',
  })
  status: VideoStatus;

  @Column({ type: 'text', nullable: true })
  error_reason: string | null;

  @Column({ type: 'varchar', length: 512 })
  storage_key_original: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key_thumbnail: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
