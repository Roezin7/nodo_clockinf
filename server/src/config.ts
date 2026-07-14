import dotenv from 'dotenv';
import {
  assertFaceProviderEnvironment,
  parseBoundedNumber,
  parseFaceProvider,
} from './services/faceProviderConfig.js';
import { assertPhotoStorageEnvironment } from './services/storageConfig.js';
import { parseWebPushConfig } from './services/pushConfig.js';
import { parseProposalAccessCodes } from './proposals/accessCodes.js';

dotenv.config();

const faceProvider = parseFaceProvider(process.env.FACE_PROVIDER);
const webPush = parseWebPushConfig(process.env);
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

function commaList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function assertProductionSecrets(input: {
  nodeEnv: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  piiEncryptionKey: string;
}): void {
  if (input.nodeEnv !== 'production') return;
  if (input.jwtSecret.length < 32 || input.jwtRefreshSecret.length < 32) {
    throw new Error('JWT_SECRET y JWT_REFRESH_SECRET requieren al menos 32 caracteres en producción');
  }
  if (input.jwtSecret === input.jwtRefreshSecret) {
    throw new Error('JWT_SECRET y JWT_REFRESH_SECRET deben ser distintos');
  }
  if (!input.piiEncryptionKey) {
    throw new Error('Falta variable de entorno: PII_ENCRYPTION_KEY');
  }
  const validPiiKey = /^[0-9a-fA-F]{64}$/.test(input.piiEncryptionKey)
    || Buffer.from(input.piiEncryptionKey, 'base64').length === 32;
  if (!validPiiKey) {
    throw new Error('PII_ENCRYPTION_KEY debe codificar exactamente 32 bytes');
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = required('JWT_SECRET');
const jwtRefreshSecret = required('JWT_REFRESH_SECRET');
const piiEncryptionKey = process.env.PII_ENCRYPTION_KEY ?? '';
assertProductionSecrets({ nodeEnv, jwtSecret, jwtRefreshSecret, piiEncryptionKey });

export const config = {
  nodeEnv,
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret,
  jwtRefreshSecret,
  piiEncryptionKey,
  corsOrigins: commaList(process.env.CORS_ORIGINS),
  // The public, owner-facing demo is isolated from operational attendance.
  // Its organization is intentionally explicit to avoid exposing every tenant.
  demoKioskOrganizationSlug: process.env.DEMO_KIOSK_ORGANIZATION_SLUG ?? '',
  // slug -> SHA-256 del código. Los códigos en texto claro nunca entran al repo.
  proposalAccessCodes: parseProposalAccessCodes(process.env.PROPOSAL_ACCESS_CODES),
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
  webPush,
} as const;
