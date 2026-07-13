import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  CalendarCheck,
  FileSpreadsheet,
  Settings as SettingsIcon,
  ShieldCheck,
  AlertTriangle,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { Organization, UserRole } from '@clockai/shared';
import { useAuth } from './hooks/useAuth';
import { api, logout } from './api';
import { setAppTimezone } from './time';
import { ToastProvider } from './components/ui';
import LoginPage from './pages/LoginPage';
import EmployeesPage from './pages/EmployeesPage';
import KioskPage from './pages/KioskPage';
import DashboardPage from './pages/DashboardPage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import StyleguidePage from './pages/StyleguidePage';
import IdentityReviewsPage from './pages/IdentityReviewsPage';
import ExceptionsPage from './pages/ExceptionsPage';
import { NotificationsBell } from './components/NotificationsBell';
import { canAccessRoute, landingRoute, type ProtectedRoute } from './auth/accessPolicy';

const NAV = [
  { to: '/dashboard', label: 'Operación', icon: LayoutDashboard, roles: ['admin', 'foreman'] },
  { to: '/employees', label: 'Empleados', icon: Users, roles: ['admin', 'foreman'] },
  { to: '/attendance', label: 'Asistencia', icon: CalendarCheck, roles: ['admin', 'foreman'] },
  { to: '/exceptions', label: 'Incidencias', icon: AlertTriangle, roles: ['admin', 'foreman'] },
  { to: '/identity-reviews', label: 'Identidad', icon: ShieldCheck, roles: ['admin', 'foreman'] },
  { to: '/reports', label: 'Reporte semanal', icon: FileSpreadsheet, roles: ['admin', 'accountant'] },
  { to: '/settings', label: 'Configuración', icon: SettingsIcon, roles: ['admin'] },
] as const;

const SIDEBAR_KEY = 'clockai.sidebar.collapsed';

function Shell({ children }: { children: React.ReactNode }) {
  const user = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');

  // La zona horaria de la planta gobierna TODA la presentación de horas
  useEffect(() => {
    if (user) {
      void api<Organization>('/api/organization')
        .then((organization) => setAppTimezone(organization.timezone))
        .catch(() => {});
    }
  }, [user]);

  if (!user) return <Navigate to="/login" replace />;

  function toggleSidebar(): void {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
      return !c;
    });
  }

  const showLabels = !collapsed;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar fija: 240px, colapsable a 64px; en móvil siempre 64px */}
      <aside
        className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-line bg-raised transition-[width] duration-200 ${
          collapsed ? 'w-16' : 'w-16 md:w-60'
        }`}
      >
        <div className={`flex h-14 items-center border-b border-line ${showLabels ? 'px-4' : 'justify-center'}`}>
          <span className="font-display text-16 font-bold text-accent">
            N{showLabels && <span className="max-md:hidden">ODO</span>}
          </span>
          {showLabels && (
            <span className="ml-1.5 font-display text-16 font-semibold text-ink max-md:hidden">Clock-In</span>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 py-3" aria-label="Principal">
          {NAV.filter(({ roles }) => (roles as readonly UserRole[]).includes(user.role)).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                `relative flex h-10 items-center gap-3 text-14 font-medium transition-colors duration-150 ${
                  showLabels ? 'px-4' : 'justify-center px-0'
                } ${
                  isActive
                    ? 'bg-accent-subtle text-accent before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-accent'
                    : 'text-ink-secondary hover:bg-sunken hover:text-ink'
                }`
              }
            >
              <Icon size={18} strokeWidth={1.5} className="shrink-0" />
              {showLabels && <span className="max-md:hidden">{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          {showLabels && (
            <div className="mb-2 px-1 max-md:hidden">
              <p className="truncate text-13 font-medium text-ink">{user.name}</p>
              <p className="text-12 capitalize text-ink-tertiary">{user.role}</p>
            </div>
          )}
          <div className={`flex gap-1 ${showLabels ? '' : 'flex-col items-center'}`}>
            <button
              onClick={() => {
                logout();
                navigate('/login');
              }}
              title="Cerrar sesión"
              className="flex h-8 flex-1 items-center justify-center gap-2 rounded-control text-13 font-medium text-ink-secondary transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <LogOut size={16} strokeWidth={1.5} />
              {showLabels && <span className="max-md:hidden">Salir</span>}
            </button>
            <button
              onClick={toggleSidebar}
              title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
              className="hidden h-8 w-8 items-center justify-center rounded-control text-ink-tertiary transition-colors duration-150 hover:bg-sunken hover:text-ink md:flex"
            >
              {collapsed ? (
                <PanelLeftOpen size={16} strokeWidth={1.5} />
              ) : (
                <PanelLeftClose size={16} strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {user.role !== 'accountant' && (
          <div className="sticky top-0 z-30 flex h-14 items-center justify-end border-b border-line bg-base/95 px-6 backdrop-blur">
            <NotificationsBell />
          </div>
        )}
        <div className="mx-auto max-w-7xl p-6">{children}</div>
      </main>
    </div>
  );
}

function RoleHome() {
  const user = useAuth();
  return <Navigate to={user ? landingRoute(user.role) : '/login'} replace />;
}

function RoleGuard({ route, children }: { route: ProtectedRoute; children: React.ReactNode }) {
  const user = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!canAccessRoute(user.role, route)) return <Navigate to={landingRoute(user.role)} replace />;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/kiosk" element={<KioskPage />} />
        <Route path="/" element={<RoleHome />} />
        <Route path="/dashboard" element={<RoleGuard route="/dashboard"><Shell><DashboardPage /></Shell></RoleGuard>} />
        <Route path="/employees" element={<RoleGuard route="/employees"><Shell><EmployeesPage /></Shell></RoleGuard>} />
        <Route path="/attendance" element={<RoleGuard route="/attendance"><Shell><AttendancePage /></Shell></RoleGuard>} />
        <Route path="/exceptions" element={<RoleGuard route="/exceptions"><Shell><ExceptionsPage /></Shell></RoleGuard>} />
        <Route path="/identity-reviews" element={<RoleGuard route="/identity-reviews"><Shell><IdentityReviewsPage /></Shell></RoleGuard>} />
        <Route path="/identity" element={<Navigate to="/identity-reviews" replace />} />
        <Route path="/reports" element={<RoleGuard route="/reports"><Shell><ReportsPage /></Shell></RoleGuard>} />
        <Route path="/settings" element={<RoleGuard route="/settings"><Shell><SettingsPage /></Shell></RoleGuard>} />
        <Route path="/styleguide" element={<RoleGuard route="/styleguide"><Shell><StyleguidePage /></Shell></RoleGuard>} />
        <Route path="*" element={<RoleHome />} />
      </Routes>
    </ToastProvider>
  );
}
