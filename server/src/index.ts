import { createApp } from './app.js';
import { config } from './config.js';
import { schedulePhotoRetention } from './jobs/photoRetention.js';
import { scheduleOperationalReconciliation } from './jobs/operationalReconciliation.js';
import { scheduleNotificationWorkers } from './jobs/notificationWorker.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`NODO CLOCK-IN server escuchando en :${config.port}`);
});

schedulePhotoRetention();
scheduleOperationalReconciliation();
scheduleNotificationWorkers();
