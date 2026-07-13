import dotenv from 'dotenv';
import {
  assertFaceProviderEnvironment,
  parseBoundedNumber,
  parseFaceProvider,
} from './services/faceProviderConfig.js';
import { assertPhotoStorageEnvironment } from './services/storageConfig.js';

dotenv.config();

const faceProvider = parseFaceProvider(process.env.FACE_PROVIDER);
assertFaceProviderEnvironment(faceProvider, process.env.NODE_ENV);
assertPhotoStorageEnvironment({
  nodeEnv: process.env.NODE_ENV,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  bucket: process.env.S3_BUCKET,
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS ?? '30', 10),
  plantTimezone: process.env.PLANT_TIMEZONE ?? 'America/Los_Angeles',
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    bucket: process.env.S3_BUCKET ?? 'clockai-photos',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    region: process.env.S3_REGION ?? 'auto',
  },
  face: {
    provider: faceProvider,
    awsRegion: process.env.FACE_AWS_REGION ?? process.env.AWS_REGION ?? 'us-west-2',
    similarityThreshold: parseBoundedNumber(
      'FACE_SIMILARITY_THRESHOLD',
      process.env.FACE_SIMILARITY_THRESHOLD,
      { defaultValue: 95, min: 80, max: 100 }
    ),
    sessionTtlSeconds: parseBoundedNumber(
      'FACE_SESSION_TTL_SECONDS',
      process.env.FACE_SESSION_TTL_SECONDS,
      { defaultValue: 600, min: 60, max: 3600, integer: true }
    ),
  },
} as const;
