// Access tokens live only in JS memory. The rotating refresh credential is an
// HttpOnly/SameSite cookie and is never readable by the application.
import type { LoginResponse, User } from '@clockai/shared';

const SESSION_USER_KEY = 'clockai.session.user';

interface MemoryAuth {
  access_token: string;
  user: User;
}

let memoryAuth: MemoryAuth | null = null;

export function getStoredAuth(): MemoryAuth | null {
  return memoryAuth;
}

export function getKnownUser(): User | null {
  if (memoryAuth) return memoryAuth.user;
  const raw = sessionStorage.getItem(SESSION_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    sessionStorage.removeItem(SESSION_USER_KEY);
    return null;
  }
}

export function storeAuth(auth: MemoryAuth | null): void {
  memoryAuth = auth;
  if (auth) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(auth.user));
  else sessionStorage.removeItem(SESSION_USER_KEY);
  window.dispatchEvent(new Event('clockai-auth-changed'));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      storeAuth(null);
      return false;
    }
    const data = (await res.json()) as LoginResponse;
    storeAuth({ access_token: data.access_token, user: data.user });
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function authenticatedFetch(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body) headers.set('Content-Type', 'application/json');
  if (memoryAuth) headers.set('Authorization', `Bearer ${memoryAuth.access_token}`);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401 && retry && (memoryAuth || getKnownUser())) {
    if (await tryRefresh()) return authenticatedFetch(path, options, false);
  }
  return response;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await authenticatedFetch(path, options);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string; code?: string; details?: unknown;
    };
    throw new ApiError(res.status, body.error ?? `Error ${res.status}`, body.code, body.details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, body.error ?? 'Error de login', body.code, body.details);
  }
  const data = (await res.json()) as LoginResponse;
  storeAuth({ access_token: data.access_token, user: data.user });
  return data.user;
}

export function logout(): void {
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  storeAuth(null);
}
