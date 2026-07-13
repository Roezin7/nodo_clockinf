import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, ApiError } from '../api';
import { Button } from '../components/ui';
import { Field, Input } from '../components/ui';
import { landingRoute } from '../auth/accessPolicy';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email, password);
      navigate(landingRoute(user.role), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error de conexión');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded-card border border-line bg-raised p-8 shadow-card"
      >
        <p className="font-display text-18 font-bold text-accent">
          NODO <span className="font-semibold text-ink">Clock-In</span>
        </p>
        <p className="mt-1 text-13 text-ink-secondary">Control de asistencia</p>

        <div className="mt-6 grid gap-1">
          <Field label="Correo" required>
            <Input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Contraseña" required error={error}>
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" loading={busy} className="mt-2 w-full">
          Entrar
        </Button>
      </form>
    </div>
  );
}
