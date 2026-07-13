import { beforeEach, describe, expect, it } from 'vitest';
import {
  lockedForSeconds,
  recordFailure,
  recordSuccess,
  resetPinLimiterForTests,
} from './pinLimiter.js';

describe('PIN limiter tenant scope', () => {
  beforeEach(resetPinLimiterForTests);

  it('locks only the same organization and employee number', () => {
    recordFailure('org-a', 42, 1_000);
    recordFailure('org-a', 42, 1_001);
    recordFailure('org-a', 42, 1_002);
    expect(lockedForSeconds('org-a', 42, 1_002)).toBe(60);
    expect(lockedForSeconds('org-b', 42, 1_002)).toBe(0);
    expect(lockedForSeconds('org-a', 43, 1_002)).toBe(0);
  });

  it('a success clears only its scoped key', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordFailure('org-a', 7, 2_000 + attempt);
      recordFailure('org-b', 7, 2_000 + attempt);
    }
    recordSuccess('org-a', 7);
    expect(lockedForSeconds('org-a', 7, 2_002)).toBe(0);
    expect(lockedForSeconds('org-b', 7, 2_002)).toBe(60);
  });
});
