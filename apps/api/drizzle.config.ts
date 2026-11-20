import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

const envFile = new URL('../../.env', import.meta.url);

if (process.env.DATABASE_URL === undefined && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
