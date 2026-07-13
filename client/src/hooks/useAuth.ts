import { useEffect, useState } from 'react';
import type { User } from '@clockai/shared';
import { getKnownUser } from '../api';

export function useAuth(): User | null {
  const [user, setUser] = useState<User | null>(() => getKnownUser());
  useEffect(() => {
    const onChange = () => setUser(getKnownUser());
    window.addEventListener('clockai-auth-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('clockai-auth-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return user;
}
