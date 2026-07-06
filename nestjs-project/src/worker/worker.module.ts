import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
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
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
        },
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    StorageModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
