import { describe, expect, it } from 'vitest';
import { failedDemoIdentityOutcome } from './kioskDemo';

describe('public kiosk demonstration', () => {
  it('explains the production three-failure escalation without creating a punch', () => {
    expect(failedDemoIdentityOutcome(1)).toBe('retry');
    expect(failedDemoIdentityOutcome(2)).toBe('retry');
    expect(failedDemoIdentityOutcome(3)).toBe('review');
  });
});
