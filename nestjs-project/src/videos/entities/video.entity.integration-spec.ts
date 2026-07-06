import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft when not specified', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        storage_key_original: `videos/placeholder/original.mp4`,
      }),
    );

    expect(video.status).toBe('draft');
  });

  it('should reject an invalid channel_id (FK violation)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan Video',
          storage_key_original: 'videos/placeholder/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Related Video',
        storage_key_original: 'videos/placeholder/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
