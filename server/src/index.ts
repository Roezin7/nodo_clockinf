import { createApp } from './app.js';
import { config } from './config.js';
import { schedulePhotoRetention } from './jobs/photoRetention.js';
import { scheduleOperationalReconciliation } from './jobs/operationalReconciliation.js';
import { scheduleNotificationWorkers } from './jobs/notificationWorker.js';
import { pool } from './db.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_listening', port: config.port }));
});

const stopJobs = [
  schedulePhotoRetention(),
  scheduleOperationalReconciliation(),
  scheduleNotificationWorkers(),
];

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  for (const stop of stopJobs) stop();
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  server.close(async () => {
    await pool.end();
    clearTimeout(force);
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_complete', signal }));
    process.exit(0);
  });
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
