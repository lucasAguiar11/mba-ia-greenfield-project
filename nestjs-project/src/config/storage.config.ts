import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  internalEndpoint: process.env.STORAGE_INTERNAL_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || 'minioadmin',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
}));
