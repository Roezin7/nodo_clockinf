import { useEffect, useState } from 'react';
import type { User } from '@clockai/shared';
import { getStoredAuth } from '../api';

export function useAuth(): User | null {
  const [user, setUser] = useState<User | null>(() => getStoredAuth()?.user ?? null);
  useEffect(() => {
    const onChange = () => setUser(getStoredAuth()?.user ?? null);
    window.addEventListener('clockai-auth-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('clockai-auth-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return user;
}
