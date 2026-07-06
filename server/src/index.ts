import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`NODO CLOCK-IN server escuchando en :${config.port}`);
});
