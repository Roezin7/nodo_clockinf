import { describe, expect, it } from 'vitest';
import { DEMO_API_ALLOWLIST, DEMO_DATASET_ID, DEMO_EMPLOYEES } from './demoData';

describe('proposal demo isolation', () => {
  it('uses a namespaced fixture set and no production identifiers', () => {
    expect(DEMO_DATASET_ID).toMatch(/^nodo-proposal-fixtures-/);
    expect(DEMO_EMPLOYEES).toHaveLength(3);
    for (const employee of DEMO_EMPLOYEES) {
      expect(employee.id).toMatch(/^demo-/);
      expect(employee).not.toHaveProperty('organizationId');
      expect(employee).not.toHaveProperty('photo');
      expect(employee).not.toHaveProperty('rate');
    }
  });

  it('only permits proposal APIs from the commercial experience', () => {
    expect(DEMO_API_ALLOWLIST).toEqual(['/api/proposals/']);
    expect(DEMO_API_ALLOWLIST.join(' ')).not.toMatch(/punches|employees|identity|dashboard|reports/);
  });
});
