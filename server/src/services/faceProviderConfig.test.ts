import { describe, expect, it } from 'vitest';
import {
  assertFaceProviderEnvironment,
  parseBoundedNumber,
  parseFaceProvider,
} from './faceProviderConfig.js';

describe('face provider configuration', () => {
  it('defaults safely to review-only and rejects unknown providers', () => {
    expect(parseFaceProvider(undefined)).toBe('review_only');
    expect(parseFaceProvider('')).toBe('review_only');
    expect(parseFaceProvider('aws_rekognition')).toBe('aws_rekognition');
    expect(() => parseFaceProvider('magic-camera')).toThrow(/inválido/i);
  });

  it.each(['test', 'development'])('allows fake only in %s', (environment) => {
    expect(() => assertFaceProviderEnvironment('fake', environment)).not.toThrow();
  });

  it.each([undefined, '', 'staging', 'production'])('fails closed for fake in %s', (environment) => {
    expect(() => assertFaceProviderEnvironment('fake', environment)).toThrow(/sólo.*test.*development/i);
  });

  it('validates finite thresholds and integer TTL values', () => {
    const options = { defaultValue: 95, min: 80, max: 100 };
    expect(parseBoundedNumber('THRESHOLD', undefined, options)).toBe(95);
    expect(parseBoundedNumber('THRESHOLD', '97.5', options)).toBe(97.5);
    expect(() => parseBoundedNumber('THRESHOLD', 'NaN', options)).toThrow();
    expect(() => parseBoundedNumber('THRESHOLD', '101', options)).toThrow();
    expect(() =>
      parseBoundedNumber('TTL', '60.5', {
        defaultValue: 600,
        min: 60,
        max: 3600,
        integer: true,
      })
    ).toThrow(/entero/i);
  });
});
