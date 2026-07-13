import { config } from '../config.js';
import { pool } from '../db.js';
import {
  createWebPushSender,
  processOperationalNotificationOutbox,
  processPendingPushDeliveries,
} from '../services/notifications.js';

/**
 * Integration point for the process scheduler. Calling this function is safe
 * from several server instances because both queues use SKIP LOCKED and
 * database uniqueness boundaries. This module deliberately starts no timer.
 */
export async function runNotificationWorkersOnce(): Promise<{
  inbox: Awaited<ReturnType<typeof processOperationalNotificationOutbox>>;
  push: Awaited<ReturnType<typeof processPendingPushDeliveries>> | null;
}> {
  const inbox = await processOperationalNotificationOutbox(pool);
  const push = config.webPush.enabled
    ? await processPendingPushDeliveries(pool, createWebPushSender(config.webPush))
    : null;
  return { inbox, push };
}

/**
 * Materializes the durable in-app inbox and then attempts optional Web Push.
 * Database row locks and uniqueness constraints provide the multi-instance
 * coordination; this process-local guard only prevents overlapping ticks in
 * one Node process.
 */
export function scheduleNotificationWorkers(): void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void runNotificationWorkersOnce()
      .then(({ inbox, push }) => {
        const changed = inbox.processed + inbox.deferred;
        const pushed = push
          ? push.delivered + push.retried + push.abandoned + push.failed
          : 0;
        if (changed > 0 || pushed > 0) {
          console.log(
            `notifications: ${inbox.processed} inbox, ${inbox.deferred} deferred, ${pushed} push`,
          );
        }
      })
      .catch((error) => console.error('notification workers:', error))
      .finally(() => {
        running = false;
      });
  };

  // The exception reconciler starts after 15 seconds. This earlier tick also
  // drains intents committed immediately before a deploy/restart.
  setTimeout(run, 5_000);
  setInterval(run, 15_000);
}
