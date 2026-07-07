import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  CalendarCheck,
  FileSpreadsheet,
  Settings as SettingsIcon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { Settings } from '@clockai/shared';
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

const NAV = [
  { to: '/dashboard', label: 'Hoy', icon: LayoutDashboard },
  { to: '/employees', label: 'Empleados', icon: Users },
  { to: '/attendance', label: 'Asistencia', icon: CalendarCheck },
  { to: '/reports', label: 'Reporte semanal', icon: FileSpreadsheet },
  { to: '/settings', label: 'Configuración', icon: SettingsIcon },
] as const;

const SIDEBAR_KEY = 'clockai.sidebar.collapsed';

function Shell({ children }: { children: React.ReactNode }) {
  const user = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');

  // La zona horaria de la planta gobierna TODA la presentación de horas
  useEffect(() => {
    if (user) {
      void api<Settings>('/api/settings')
        .then((s) => setAppTimezone(s.timezone))
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
          {NAV.map(({ to, label, icon: Icon }) => (
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
        <div className="mx-auto max-w-7xl p-6">{children}</div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/kiosk" element={<KioskPage />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Shell><DashboardPage /></Shell>} />
        <Route path="/employees" element={<Shell><EmployeesPage /></Shell>} />
        <Route path="/attendance" element={<Shell><AttendancePage /></Shell>} />
        <Route path="/reports" element={<Shell><ReportsPage /></Shell>} />
        <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />
        <Route path="/styleguide" element={<Shell><StyleguidePage /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
