import { describe, expect, it } from 'vitest';
import {
  GENERIC_OPERATIONAL_PUSH_PAYLOAD,
  isAllowedWebPushEndpoint,
  notificationRetryDelaySeconds,
  pushEndpointHash,
  serializeGenericOperationalPush,
} from './notifications.js';

describe('operational notification policy', () => {
  it('uses a deterministic bounded exponential retry schedule', () => {
    expect([1, 2, 3, 4, 9, 99].map(notificationRetryDelaySeconds)).toEqual([
      15, 30, 60, 120, 3_600, 3_600,
    ]);
  });

  it('sends only a generic payload without operational or biometric evidence', () => {
    const payload = serializeGenericOperationalPush();
    expect(JSON.parse(payload)).toEqual(GENERIC_OPERATIONAL_PUSH_PAYLOAD);
    expect(payload).not.toMatch(
      /employee|empleado|name|nombre|photo|foto|face|facial|biometric|exception_id|identity/i,
    );
    expect(JSON.parse(payload).url).toBe('/exceptions');
  });

  it('hashes browser endpoints without persisting them as identifiers', () => {
    const endpoint = 'https://push.example.test/subscription/secret-capability';
    expect(pushEndpointHash(endpoint)).toMatch(/^[0-9a-f]{64}$/);
    expect(pushEndpointHash(endpoint)).toBe(pushEndpointHash(endpoint));
    expect(pushEndpointHash(endpoint)).not.toContain('secret-capability');
  });

  it('allows supported browser push services and rejects SSRF endpoints', () => {
    expect(isAllowedWebPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedWebPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedWebPushEndpoint('https://web.push.apple.com/QP/abc')).toBe(true);
    expect(isAllowedWebPushEndpoint('https://wns2-pn3p.notify.windows.com/w/?token=x')).toBe(true);

    expect(isAllowedWebPushEndpoint('https://127.0.0.1/internal')).toBe(false);
    expect(isAllowedWebPushEndpoint('https://metadata.google.internal/latest')).toBe(false);
    expect(isAllowedWebPushEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    expect(isAllowedWebPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isAllowedWebPushEndpoint('https://user:pass@fcm.googleapis.com/x')).toBe(false);
  });
});
