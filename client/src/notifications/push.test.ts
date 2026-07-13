import { describe, expect, it } from 'vitest';
import { urlBase64ToArrayBuffer } from './push';

describe('PWA push helpers', () => {
  it('decodes the URL-safe Base64 VAPID public key representation', () => {
    expect([...new Uint8Array(urlBase64ToArrayBuffer('SGVsbG8td29ybGQ_'))]).toEqual([
      72, 101, 108, 108, 111, 45, 119, 111, 114, 108, 100, 63,
    ]);
  });
});
