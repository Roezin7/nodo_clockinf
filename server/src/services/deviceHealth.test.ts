import { describe, expect, it } from 'vitest';
import {
  deviceHealthReasons,
  deviceRevocationReasons,
  periodHeartbeatBoundary,
} from './deviceHealth.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('deviceHealthReasons', () => {
  it('reports queue, quarantine and missing heartbeat independently', () => {
    expect(
      deviceHealthReasons(
        {
          pending_event_count: 2,
          rejected_event_count: 1,
          last_heartbeat_at: null,
          storage_status: 'ready',
        },
        NOW
      )
    ).toEqual([
      '2 evento(s) pendiente(s)',
      '1 evento(s) rechazado(s)',
      'Sin heartbeat registrado',
    ]);
  });

  it('accepts exactly 24 hours and blocks anything older', () => {
    expect(
      deviceHealthReasons(
        {
          pending_event_count: 0,
          rejected_event_count: 0,
          storage_status: 'ready',
          last_heartbeat_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        },
        NOW
      )
    ).toEqual([]);
    expect(
      deviceHealthReasons(
        {
          pending_event_count: 0,
          rejected_event_count: 0,
          storage_status: 'ready',
          last_heartbeat_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1),
        },
        NOW
      )
    ).toEqual(['Heartbeat con más de 24 horas']);
  });

  it('requires a heartbeat strictly after the real period boundary', () => {
    const boundary = new Date('2026-07-12T07:00:00.000Z'); // Sunday 00:00 PDT
    const shortlyAfterBoundary = new Date(boundary.getTime() + 60 * 60 * 1000);
    const healthy = {
      pending_event_count: 0,
      rejected_event_count: 0,
      storage_status: 'ready' as const,
    };
    expect(
      deviceHealthReasons({ ...healthy, last_heartbeat_at: boundary }, shortlyAfterBoundary, boundary)
    ).toContain('Heartbeat no confirmado después del cierre del periodo');
    expect(
      deviceHealthReasons(
        { ...healthy, last_heartbeat_at: new Date(boundary.getTime() - 1) },
        shortlyAfterBoundary,
        boundary
      )
    ).toContain('Heartbeat no confirmado después del cierre del periodo');
    expect(
      deviceHealthReasons(
        { ...healthy, last_heartbeat_at: new Date(boundary.getTime() + 1) },
        shortlyAfterBoundary,
        boundary
      )
    ).toEqual([]);
  });

  it('blocks unknown or unavailable storage, but permits degraded storage', () => {
    const base = {
      pending_event_count: 0,
      rejected_event_count: 0,
      last_heartbeat_at: NOW,
    };
    expect(deviceHealthReasons({ ...base, storage_status: 'unknown' }, NOW)).toContain(
      'Estado del almacenamiento sin confirmar'
    );
    expect(deviceHealthReasons({ ...base, storage_status: 'unavailable' }, NOW)).toContain(
      'Almacenamiento local no disponible'
    );
    expect(deviceHealthReasons({ ...base, storage_status: 'degraded' }, NOW)).toEqual([]);
  });
});

describe('periodHeartbeatBoundary', () => {
  it('uses Sunday 00:00 in Los Angeles with the correct DST offset', () => {
    expect(
      periodHeartbeatBoundary('2026-03-07', 'America/Los_Angeles').toISOString()
    ).toBe('2026-03-08T08:00:00.000Z');
    expect(
      periodHeartbeatBoundary('2026-07-11', 'America/Los_Angeles').toISOString()
    ).toBe('2026-07-12T07:00:00.000Z');
  });
});

describe('deviceRevocationReasons', () => {
  const unhealthy = {
    pending_event_count: 0,
    rejected_event_count: 0,
    last_heartbeat_at: null,
    storage_status: 'unknown' as const,
  };

  it('does not block revocation of an activation record that was never enrolled', () => {
    expect(deviceRevocationReasons({ ...unhealthy, enrolled_at: null }, NOW)).toEqual([]);
  });

  it('blocks an enrolled kiosk whose storage is unknown or heartbeat is missing', () => {
    expect(
      deviceRevocationReasons(
        { ...unhealthy, enrolled_at: new Date('2026-07-10T12:00:00.000Z') },
        NOW
      )
    ).toEqual(['Estado del almacenamiento sin confirmar', 'Sin heartbeat registrado']);
  });

  it('permits normal revocation only when an enrolled kiosk is healthy and drained', () => {
    expect(
      deviceRevocationReasons(
        {
          enrolled_at: new Date('2026-07-10T12:00:00.000Z'),
          pending_event_count: 0,
          rejected_event_count: 0,
          last_heartbeat_at: NOW,
          storage_status: 'ready',
        },
        NOW
      )
    ).toEqual([]);
  });
});
