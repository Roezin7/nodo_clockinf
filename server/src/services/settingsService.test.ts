import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TIMEZONE_IDS,
  assertAllowedOperationalTimezone,
} from './settingsService.js';

describe('Modesto operational timezone invariant', () => {
  it('allows only America/Los_Angeles for the deployed California policy', () => {
    expect(ALLOWED_TIMEZONE_IDS).toEqual(['America/Los_Angeles']);
    expect(() => assertAllowedOperationalTimezone('America/Los_Angeles')).not.toThrow();
    expect(() => assertAllowedOperationalTimezone('America/New_York')).toThrow(
      /America\/Los_Angeles/,
    );
  });
});
