import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';
const AAD = Buffer.from('clockai:ssn:v1', 'utf8');

function encryptionKey(): Buffer {
  const configured = config.piiEncryptionKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(configured)) return Buffer.from(configured, 'hex');
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    throw new Error('PII_ENCRYPTION_KEY debe ser 32 bytes en hex o base64');
  }
  // Local/test convenience only. Production configuration rejects a missing
  // dedicated key before this module can be used.
  return crypto.createHash('sha256').update(`${config.jwtSecret}:clockai-pii-dev`).digest();
}

export function isEncryptedSensitiveValue(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSensitiveValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isEncryptedSensitiveValue(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSensitiveValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncryptedSensitiveValue(value)) return value; // legacy migration path
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Valor PII cifrado inválido');
  const [ivText, tagText, encryptedText] = parts as [string, string, string];
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
