import { describe, expect, it } from 'vitest';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isEncryptedSensitiveValue,
} from './piiCrypto.js';

describe('PII envelope encryption', () => {
  it('encrypts nondeterministically and authenticates the SSN value', () => {
    const first = encryptSensitiveValue('111-22-3333')!;
    const second = encryptSensitiveValue('111-22-3333')!;
    expect(first).not.toBe(second);
    expect(isEncryptedSensitiveValue(first)).toBe(true);
    expect(decryptSensitiveValue(first)).toBe('111-22-3333');
  });

  it('supports plaintext only as a legacy read and preserves null', () => {
    expect(decryptSensitiveValue('legacy')).toBe('legacy');
    expect(encryptSensitiveValue(null)).toBeNull();
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSensitiveValue('111-22-3333')!;
    expect(() => decryptSensitiveValue(`${encrypted.slice(0, -1)}x`)).toThrow();
  });
});
