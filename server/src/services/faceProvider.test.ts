import { describe, expect, it } from 'vitest';
import type { RekognitionClient } from '@aws-sdk/client-rekognition';
import {
  AwsRekognitionFaceProvider,
  FakeFaceProvider,
  ReviewOnlyFaceProvider,
} from './faceProvider.js';
import { supportedFaceImage } from './identityService.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const webp = Buffer.from('RIFFxxxxWEBPdata', 'ascii');

describe('face image evidence validation', () => {
  it('accepts supported MIME types only when their magic bytes agree', () => {
    expect(supportedFaceImage(jpeg, 'image/jpeg')).toBe(true);
    expect(supportedFaceImage(png, 'image/png')).toBe(true);
    expect(supportedFaceImage(webp, 'image/webp')).toBe(true);
    expect(supportedFaceImage(png, 'image/jpeg')).toBe(false);
    expect(supportedFaceImage(jpeg, 'image/png')).toBe(false);
    expect(supportedFaceImage(jpeg, 'application/octet-stream')).toBe(false);
    expect(supportedFaceImage(Buffer.alloc(0), 'image/jpeg')).toBe(false);
  });
});

describe('face providers', () => {
  it('keeps review-only explicitly non-automatic', async () => {
    const provider = new ReviewOnlyFaceProvider();
    await expect(provider.verify()).resolves.toMatchObject({
      result: 'review_only',
      livenessStatus: 'not_performed',
    });
    expect(provider.livenessCapable).toBe(false);
  });

  it('uses the fake adapter only as a deterministic test seam', async () => {
    const provider = new FakeFaceProvider();
    await expect(
      provider.verify({ attemptPhoto: jpeg, enrollmentPhoto: jpeg, debugOutcome: 'no_match' })
    ).resolves.toMatchObject({ result: 'no_match', similarity: 12, livenessStatus: 'passed' });
  });

  it('treats AWS CompareFaces as comparison without liveness', async () => {
    const responses = [
      { FaceDetails: [{}] },
      { FaceMatches: [{ Similarity: 99.1 }], UnmatchedFaces: [] },
    ];
    const client = {
      send: async () => responses.shift(),
    } as unknown as RekognitionClient;
    const provider = new AwsRekognitionFaceProvider({ region: 'us-west-2', threshold: 95, client });

    await expect(
      provider.verify({ attemptPhoto: jpeg, enrollmentPhoto: jpeg })
    ).resolves.toMatchObject({
      result: 'match',
      similarity: 99.1,
      livenessStatus: 'not_performed',
    });
    expect(provider.livenessCapable).toBe(false);
  });

  it.each([
    [{ FaceDetails: [] }, 'no_face'],
    [{ FaceDetails: [{}, {}] }, 'multiple_faces'],
  ] as const)('classifies face-count evidence %#', async (detectResponse, result) => {
    const client = { send: async () => detectResponse } as unknown as RekognitionClient;
    const provider = new AwsRekognitionFaceProvider({ region: 'us-west-2', threshold: 95, client });
    await expect(
      provider.verify({ attemptPhoto: jpeg, enrollmentPhoto: jpeg })
    ).resolves.toMatchObject({ result });
  });

  it('maps a provider outage to reviewable technical failure', async () => {
    const client = {
      send: async () => {
        const error = new Error('busy');
        error.name = 'ThrottlingException';
        throw error;
      },
    } as unknown as RekognitionClient;
    const provider = new AwsRekognitionFaceProvider({ region: 'us-west-2', threshold: 95, client });
    await expect(
      provider.verify({ attemptPhoto: jpeg, enrollmentPhoto: jpeg })
    ).resolves.toMatchObject({ result: 'provider_unavailable', livenessStatus: 'not_performed' });
  });
});
