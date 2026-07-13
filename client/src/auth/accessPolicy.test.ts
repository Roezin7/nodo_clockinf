import { describe, expect, it } from 'vitest';
import type { UserRole } from '@clockai/shared';
import { canAccessRoute, landingRoute, PROTECTED_ROUTE_ROLES } from './accessPolicy';

describe('matriz central de rutas por rol', () => {
  it('envía accountant a reportes al entrar y le niega rutas operativas/sensibles', () => {
    expect(landingRoute('accountant')).toBe('/reports');
    expect(canAccessRoute('accountant', '/reports')).toBe(true);
    for (const route of ['/dashboard', '/attendance', '/employees', '/exceptions', '/identity-reviews', '/settings'] as const) {
      expect(canAccessRoute('accountant', route)).toBe(false);
    }
  });

  it('mantiene una matriz exhaustiva y destinos accesibles para cada rol de organización', () => {
    const roles: UserRole[] = ['admin', 'foreman', 'accountant'];
    expect(Object.keys(PROTECTED_ROUTE_ROLES).sort()).toEqual([
      '/attendance', '/dashboard', '/employees', '/exceptions', '/identity-reviews', '/profile', '/reports', '/settings', '/styleguide',
    ]);
    for (const role of roles) {
      const destination = landingRoute(role);
      expect(destination === '/login' || canAccessRoute(role, destination)).toBe(true);
    }
    expect(canAccessRoute('foreman', '/identity-reviews')).toBe(true);
    expect(canAccessRoute('foreman', '/exceptions')).toBe(true);
    expect(canAccessRoute('foreman', '/settings')).toBe(false);
    expect(canAccessRoute('admin', '/settings')).toBe(true);
    expect(canAccessRoute('accountant', '/profile')).toBe(true);
  });
});
