import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWebPushConfig } from './pushConfig.js';

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const PUBLIC_KEY = ecdh.getPublicKey().toString('base64url');
const PRIVATE_KEY = ecdh.getPrivateKey().toString('base64url');

describe('Web Push configuration', () => {
  it('is explicitly disabled when no VAPID variable is present', () => {
    expect(parseWebPushConfig({})).toEqual({
      enabled: false,
      subject: null,
      publicKey: null,
      privateKey: null,
    });
  });

  it('accepts a complete VAPID identity', () => {
    expect(
      parseWebPushConfig({
        VAPID_SUBJECT: 'mailto:alerts@example.test',
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toEqual({
      enabled: true,
      subject: 'mailto:alerts@example.test',
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    });
  });

  it('fails closed for partial, malformed or insecure configuration', () => {
    expect(() =>
      parseWebPushConfig({ VAPID_PUBLIC_KEY: PUBLIC_KEY }),
    ).toThrow(/configured together/);
    expect(() =>
      parseWebPushConfig({
        VAPID_SUBJECT: 'http://example.test',
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toThrow(/mailto: or https:/);
    expect(() =>
      parseWebPushConfig({
        VAPID_SUBJECT: 'mailto:alerts@example.test',
        VAPID_PUBLIC_KEY: 'not valid',
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toThrow(/matching URL-safe Base64/);
    expect(() =>
      parseWebPushConfig({
        VAPID_SUBJECT: 'mailto:alerts@example.test',
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: crypto.randomBytes(32).toString('base64url'),
      }),
    ).toThrow(/matching URL-safe Base64/);
  });
});
