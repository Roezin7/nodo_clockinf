import crypto from 'node:crypto';

export interface DisabledWebPushConfig {
  enabled: false;
  subject: null;
  publicKey: null;
  privateKey: null;
}

export interface EnabledWebPushConfig {
  enabled: true;
  subject: string;
  publicKey: string;
  privateKey: string;
}

export type WebPushConfig = DisabledWebPushConfig | EnabledWebPushConfig;

export interface WebPushEnvironment {
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isValidVapidKeyPair(publicKey: string, privateKey: string): boolean {
  try {
    const publicBytes = Buffer.from(publicKey, 'base64url');
    const privateBytes = Buffer.from(privateKey, 'base64url');
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) {
      return false;
    }
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    const derivedPublic = ecdh.getPublicKey();
    return (
      derivedPublic.length === publicBytes.length &&
      crypto.timingSafeEqual(derivedPublic, publicBytes)
    );
  } catch {
    return false;
  }
}

function optionalTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Web Push is optional, but a partially configured VAPID identity is unsafe:
 * fail at startup instead of silently accepting subscriptions that can never
 * be delivered.
 */
export function parseWebPushConfig(environment: WebPushEnvironment): WebPushConfig {
  const subject = optionalTrimmed(environment.VAPID_SUBJECT);
  const publicKey = optionalTrimmed(environment.VAPID_PUBLIC_KEY);
  const privateKey = optionalTrimmed(environment.VAPID_PRIVATE_KEY);
  const configured = [subject, publicKey, privateKey].filter(Boolean).length;

  if (configured === 0) {
    return { enabled: false, subject: null, publicKey: null, privateKey: null };
  }
  if (configured !== 3) {
    throw new Error(
      'VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together',
    );
  }

  let parsedSubject: URL;
  try {
    parsedSubject = new URL(subject!);
  } catch {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }
  if (parsedSubject.protocol !== 'mailto:' && parsedSubject.protocol !== 'https:') {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }
  if (
    !BASE64URL.test(publicKey!) ||
    !BASE64URL.test(privateKey!) ||
    !isValidVapidKeyPair(publicKey!, privateKey!)
  ) {
    throw new Error('VAPID keys must be a matching URL-safe Base64 P-256 key pair');
  }

  return {
    enabled: true,
    subject: subject!,
    publicKey: publicKey!,
    privateKey: privateKey!,
  };
}
