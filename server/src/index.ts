import { createApp } from './app.js';
import { config } from './config.js';
import { schedulePhotoRetention } from './jobs/photoRetention.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`NODO CLOCK-IN server escuchando en :${config.port}`);
});

schedulePhotoRetention();
