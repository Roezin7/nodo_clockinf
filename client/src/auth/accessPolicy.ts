import type { UserRole } from '@clockai/shared';

export const PROTECTED_ROUTE_ROLES = {
  '/dashboard': ['admin', 'foreman'],
  '/attendance': ['admin', 'foreman'],
  '/employees': ['admin', 'foreman'],
  '/exceptions': ['admin', 'foreman'],
  '/identity-reviews': ['admin', 'foreman'],
  '/reports': ['admin', 'accountant'],
  '/settings': ['admin'],
  '/profile': ['admin', 'foreman', 'accountant'],
  '/styleguide': ['admin'],
} as const satisfies Record<string, readonly UserRole[]>;

export type ProtectedRoute = keyof typeof PROTECTED_ROUTE_ROLES;

export function canAccessRoute(role: UserRole, route: ProtectedRoute): boolean {
  return (PROTECTED_ROUTE_ROLES[route] as readonly UserRole[]).includes(role);
}
export function landingRoute(role: UserRole): '/dashboard' | '/reports' | '/login' {
  if (role === 'accountant') return '/reports';
  if (role === 'admin' || role === 'foreman') return '/dashboard';
  return '/login';
}
