import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, logout } from '../api';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, Field, Input } from '../components/ui';

export default function ProfilePage() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (newPassword.length < 12) {
      setError('La contraseña nueva requiere al menos 12 caracteres.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('La confirmación no coincide.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      logout();
      navigate('/login', { replace: true });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'No se pudo cambiar la contraseña.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl">
      <PageHeader title="Mi cuenta" meta="La sesión se cerrará en todos los dispositivos al guardar." />
      <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-card border border-line bg-raised p-6 shadow-card">
        <Field label="Contraseña actual" required>
          <Input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </Field>
        <Field label="Contraseña nueva" hint="Mínimo 12 caracteres" required>
          <Input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
        <Field label="Confirmar contraseña" required error={error}>
          <Input type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </Field>
        <Button type="submit" loading={saving}>Cambiar contraseña y cerrar sesiones</Button>
      </form>
    </div>
  );
}
