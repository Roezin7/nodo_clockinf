import { describe, expect, it } from 'vitest';
import {
  canAccessAllPlants,
  canManageCustomerData,
  canViewIdentityEvidence,
  canViewRates,
} from './tenantService.js';

describe('role capability matrix', () => {
  it('limits customer administration and rates to customer admins', () => {
    expect(canManageCustomerData('admin')).toBe(true);
    expect(canViewRates('admin')).toBe(true);
    for (const role of ['foreman', 'accountant', 'platform_operator'] as const) {
      expect(canManageCustomerData(role)).toBe(false);
      expect(canViewRates(role)).toBe(false);
    }
  });

  it('lets accountants see all plants without operational mutation privileges', () => {
    expect(canAccessAllPlants('accountant')).toBe(true);
    expect(canManageCustomerData('accountant')).toBe(false);
    expect(canViewIdentityEvidence('accountant')).toBe(false);
  });

  it('allows foremen to review identity evidence but scopes their plants', () => {
    expect(canViewIdentityEvidence('foreman')).toBe(true);
    expect(canAccessAllPlants('foreman')).toBe(false);
  });

  it('does not give a platform operator implicit customer access', () => {
    expect(canAccessAllPlants('platform_operator')).toBe(false);
    expect(canViewRates('platform_operator')).toBe(false);
    expect(canViewIdentityEvidence('platform_operator')).toBe(false);
  });
});

