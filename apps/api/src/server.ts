import { createApp } from './app.js';
import { parsePort } from './env.js';

const port = parsePort(process.env.PORT);

createApp().listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
