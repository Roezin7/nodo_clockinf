import { useEffect } from 'react';
import { Navigate, Route, Routes, NavLink, useNavigate } from 'react-router-dom';
import type { Settings } from '@clockai/shared';
import { useAuth } from './hooks/useAuth';
import { api, logout } from './api';
import { setAppTimezone } from './time';
import LoginPage from './pages/LoginPage';
import EmployeesPage from './pages/EmployeesPage';
import KioskPage from './pages/KioskPage';
import DashboardPage from './pages/DashboardPage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';

const NAV = [
  { to: '/dashboard', label: 'Hoy' },
  { to: '/employees', label: 'Empleados' },
  { to: '/attendance', label: 'Asistencia' },
  { to: '/reports', label: 'Reporte semanal' },
  { to: '/settings', label: 'Configuración' },
];

function Shell({ children }: { children: React.ReactNode }) {
  const user = useAuth();
  const navigate = useNavigate();

  // La zona horaria de la planta gobierna TODA la presentación de horas
  useEffect(() => {
    if (user) {
      void api<Settings>('/api/settings')
        .then((s) => setAppTimezone(s.timezone))
        .catch(() => {});
    }
  }, [user]);

  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="text-lg font-extrabold tracking-tight text-wine-600">
            NODO <span className="font-medium text-ink">CLOCK-IN</span>
          </span>
          <nav className="flex flex-1 gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-semibold ${
                    isActive ? 'bg-wine-50 text-wine-700' : 'text-ink-soft hover:bg-surface'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-soft">
              {user.name} · {user.role}
            </span>
            <button
              className="rounded-lg border border-line px-3 py-1.5 font-semibold hover:bg-surface"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/kiosk" element={<KioskPage />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Shell><DashboardPage /></Shell>} />
      <Route path="/employees" element={<Shell><EmployeesPage /></Shell>} />
      <Route path="/attendance" element={<Shell><AttendancePage /></Shell>} />
      <Route path="/reports" element={<Shell><ReportsPage /></Shell>} />
      <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
