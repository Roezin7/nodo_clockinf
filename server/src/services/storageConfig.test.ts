import { describe, expect, it } from 'vitest';
import { assertPhotoStorageEnvironment } from './storageConfig.js';

describe('photo storage configuration', () => {
  it('allows local storage only outside production', () => {
    expect(() =>
      assertPhotoStorageEnvironment({
        nodeEnv: 'development',
        accessKeyId: undefined,
        secretAccessKey: undefined,
        bucket: undefined,
      })
    ).not.toThrow();
  });

  it.each([
    { accessKeyId: 'access', secretAccessKey: undefined },
    { accessKeyId: undefined, secretAccessKey: 'secret' },
  ])('rejects partial credentials', ({ accessKeyId, secretAccessKey }) => {
    expect(() =>
      assertPhotoStorageEnvironment({
        nodeEnv: 'development',
        accessKeyId,
        secretAccessKey,
        bucket: 'bucket',
      })
    ).toThrow(/configurarse juntos/i);
  });

  it('fails closed when production has no explicit durable bucket/credentials', () => {
    expect(() =>
      assertPhotoStorageEnvironment({
        nodeEnv: 'production',
        accessKeyId: undefined,
        secretAccessKey: undefined,
        bucket: undefined,
      })
    ).toThrow(/almacenamiento durable/i);
    expect(() =>
      assertPhotoStorageEnvironment({
        nodeEnv: 'production',
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        bucket: undefined,
      })
    ).toThrow(/S3_BUCKET/i);
  });

  it('accepts complete durable production storage', () => {
    expect(() =>
      assertPhotoStorageEnvironment({
        nodeEnv: 'production',
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        bucket: 'clockai-photos',
      })
    ).not.toThrow();
  });
});
