import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, ApiError } from '../api';

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
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error de conexión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-2xl border border-line bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-extrabold tracking-tight text-wine-600">
          NODO <span className="font-medium text-ink">CLOCK-IN</span>
        </h1>
        <p className="mt-1 text-sm text-ink-soft">Control de asistencia</p>

        <label className="mt-6 block text-sm font-semibold">Correo</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-wine-500"
        />
        <label className="mt-4 block text-sm font-semibold">Contraseña</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-wine-500"
        />
        {error && <p className="mt-3 text-sm font-semibold text-bad">{error}</p>}
        <button
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-wine-600 py-2.5 font-bold text-white hover:bg-wine-700 disabled:opacity-50"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
