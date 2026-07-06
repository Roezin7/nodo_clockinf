// Cliente HTTP con manejo de access/refresh tokens.
import type { LoginResponse, User } from '@clockai/shared';

const STORAGE_KEY = 'clockai.auth';

interface StoredAuth {
  access_token: string;
  refresh_token: string;
  user: User;
}

export function getStoredAuth(): StoredAuth | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

export function storeAuth(auth: StoredAuth | null): void {
  if (auth) localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('clockai-auth-changed'));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const auth = getStoredAuth();
    if (!auth) return false;
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
    if (!res.ok) {
      storeAuth(null);
      return false;
    }
    const data = (await res.json()) as LoginResponse;
    storeAuth({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const auth = getStoredAuth();
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (auth) headers.set('Authorization', `Bearer ${auth.access_token}`);

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && retry && auth) {
    if (await tryRefresh()) return api<T>(path, options, false);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? 'Error de login');
  }
  const data = (await res.json()) as LoginResponse;
  storeAuth({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
  return data.user;
}

export function logout(): void {
  const auth = getStoredAuth();
  if (auth) {
    void fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
  }
  storeAuth(null);
}
