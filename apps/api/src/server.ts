import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { parsePort } from './env.js';

const port = parsePort(process.env.PORT);

const { db } = createDatabase();

createApp({ db }).listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
