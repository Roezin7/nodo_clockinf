import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellRing, CheckCheck, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { fmtDateTime } from '../time';
import { Button, useToast } from './ui';
import {
  getUnreadOperationalNotificationCount,
  listOperationalNotifications,
  markAllOperationalNotificationsRead,
  markOperationalNotificationRead,
  type NotificationPage,
} from '../notifications/inbox';
import {
  browserSupportsPush,
  disableOperationalPush,
  enableOperationalPush,
  getPushAvailability,
} from '../notifications/push';

const EMPTY_PAGE: NotificationPage = {
  items: [],
  total: 0,
  unread: 0,
  next_offset: null,
};

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/** Admin/foreman inbox. The parent must not mount this component for accountants. */
export function NotificationsBell() {
  const navigate = useNavigate();
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [page, setPage] = useState<NotificationPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushActive, setPushActive] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const result = await getUnreadOperationalNotificationCount();
      setUnread(result.unread);
    } catch {
      // A polling failure must not interrupt the rest of the application.
    }
  }, []);

  const loadInbox = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listOperationalNotifications({ limit: 30 });
      if (request.current !== id) return;
      setPage(result);
      setUnread(result.unread);
    } catch (loadError) {
      if (request.current === id) {
        setError(message(loadError, 'No fue posible cargar las notificaciones.'));
      }
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCount();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCount();
    }, 30_000);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void loadCount();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadCount]);

  useEffect(() => {
    if (!open) return;
    void loadInbox();
  }, [loadInbox, open]);

  useEffect(() => {
    if (!browserSupportsPush()) return;
    let active = true;
    void getPushAvailability()
      .then(async (availability) => {
        if (!active) return;
        setPushAvailable(availability.enabled);
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (active) setPushActive(Boolean(subscription));
      })
      .catch(() => {
        if (active) setPushAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function markAllRead(): Promise<void> {
    try {
      await markAllOperationalNotificationsRead();
      const now = new Date().toISOString();
      setPage((current) => ({
        ...current,
        unread: 0,
        items: current.items.map((item) => ({ ...item, read_at: item.read_at ?? now })),
      }));
      setUnread(0);
    } catch (markError) {
      toast(message(markError, 'No fue posible marcar las notificaciones.'), 'danger');
    }
  }

  async function openNotification(notificationId: string, wasUnread: boolean): Promise<void> {
    if (wasUnread) {
      try {
        const result = await markOperationalNotificationRead(notificationId);
        setPage((current) => ({
          ...current,
          unread: Math.max(0, current.unread - 1),
          items: current.items.map((item) =>
            item.id === notificationId ? { ...item, read_at: result.read_at } : item,
          ),
        }));
        setUnread((current) => Math.max(0, current - 1));
      } catch {
        // Navigation remains useful while offline; the inbox can retry later.
      }
    }
    setOpen(false);
    // Operational notification routes are intentionally fixed client-side so
    // a compromised row cannot become an open redirect.
    navigate('/exceptions');
  }

  async function togglePush(): Promise<void> {
    setPushBusy(true);
    try {
      if (pushActive) {
        await disableOperationalPush();
        setPushActive(false);
        toast('Avisos del navegador desactivados');
      } else {
        await enableOperationalPush();
        setPushActive(true);
        toast('Avisos del navegador activados');
      }
    } catch (pushError) {
      toast(message(pushError, 'No fue posible cambiar los avisos.'), 'danger');
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={unread > 0 ? `Notificaciones: ${unread} sin leer` : 'Notificaciones'}
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-control border border-line bg-raised text-ink-secondary shadow-card transition-colors hover:bg-sunken hover:text-ink"
      >
        {unread > 0 ? <BellRing size={17} /> : <Bell size={17} />}
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-danger px-1 text-center text-11 font-bold leading-5 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <section
          aria-label="Notificaciones operativas"
          className="absolute right-0 top-11 z-50 w-[min(92vw,390px)] overflow-hidden rounded-card border border-line bg-raised shadow-modal"
        >
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-15 font-semibold text-ink">Notificaciones</h2>
              <p className="text-12 text-ink-tertiary">{unread} sin leer</p>
            </div>
            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                <CheckCheck size={14} /> Marcar todas
              </Button>
            )}
          </header>

          <div className="max-h-[55vh] overflow-y-auto">
            {loading ? (
              <div className="flex min-h-36 items-center justify-center text-ink-tertiary">
                <Loader2 className="animate-spin" size={20} aria-label="Cargando" />
              </div>
            ) : error ? (
              <div className="p-5 text-center text-13 text-danger" role="alert">
                <p>{error}</p>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => void loadInbox()}>
                  Reintentar
                </Button>
              </div>
            ) : page.items.length === 0 ? (
              <p className="p-8 text-center text-13 text-ink-tertiary">No hay notificaciones todavía.</p>
            ) : (
              <ul className="divide-y divide-line">
                {page.items.map((item) => {
                  const isUnread = item.read_at === null;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => void openNotification(item.id, isUnread)}
                        className={`block w-full px-4 py-3 text-left transition-colors hover:bg-sunken ${
                          isUnread ? 'bg-accent-subtle/40' : ''
                        }`}
                      >
                        <span className="flex items-start gap-2">
                          <span
                            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                              isUnread ? 'bg-accent' : 'bg-transparent'
                            }`}
                            aria-hidden
                          />
                          <span className="min-w-0">
                            <span className="block text-13 font-semibold text-ink">{item.title}</span>
                            <span className="mt-0.5 block text-12 text-ink-secondary">{item.body}</span>
                            <span className="tnum mt-1 block text-11 text-ink-tertiary">
                              {fmtDateTime(item.created_at)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/exceptions');
              }}
              className="text-12 font-semibold text-accent hover:underline"
            >
              Abrir incidencias
            </button>
            {pushAvailable && (
              <Button variant="secondary" size="sm" disabled={pushBusy} onClick={() => void togglePush()}>
                {pushBusy && <Loader2 size={13} className="animate-spin" />}
                {pushActive ? 'Desactivar avisos' : 'Activar avisos'}
              </Button>
            )}
          </footer>
        </section>
      )}
    </div>
  );
}
