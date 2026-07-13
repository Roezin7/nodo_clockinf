import { api } from '../api';

export interface OperationalNotification {
  id: string;
  event_type: 'opened' | 'acknowledged' | 'resolved' | 'reopened';
  severity: 'blocker' | 'warning';
  exception_code: string;
  title: string;
  body: string;
  action_url: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPage {
  items: OperationalNotification[];
  total: number;
  unread: number;
  next_offset: number | null;
}

export function listOperationalNotifications(
  options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<NotificationPage> {
  const params = new URLSearchParams({
    unread_only: String(options.unreadOnly ?? false),
    limit: String(options.limit ?? 30),
    offset: String(options.offset ?? 0),
  });
  return api<NotificationPage>(`/api/notifications?${params}`);
}

export function getUnreadOperationalNotificationCount(): Promise<{ unread: number }> {
  return api<{ unread: number }>('/api/notifications/unread-count');
}

export function markOperationalNotificationRead(
  notificationId: string,
): Promise<{ id: string; read_at: string }> {
  return api(`/api/notifications/${notificationId}/read`, { method: 'POST' });
}

export function markAllOperationalNotificationsRead(): Promise<{ updated: number }> {
  return api('/api/notifications/read-all', { method: 'POST' });
}
