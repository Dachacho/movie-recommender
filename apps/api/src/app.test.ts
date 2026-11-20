import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createDatabase, type Database } from './db/client.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function listen(
  app: ReturnType<typeof createApp>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to bind to a TCP port');
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}

describe('GET /health', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp({ db: {} as Database })));
  });

  afterAll(async () => {
    await close(server);
  });

  it('reports ok', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('mounted API routes', () => {
  let pool: Pool;
  let db: Database;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));
    ({ server, baseUrl } = await listen(createApp({ db })));
  });

  afterAll(async () => {
    if (server !== undefined) {
      await close(server);
    }

    if (pool !== undefined) {
      await pool.end();
    }
  });

  it('returns 400 invalid_json for a malformed JSON body', async () => {
    const response = await fetch(`${baseUrl}/taste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ratings":',
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe('invalid_json');
    expect(body.error.message).toBe('Request body must be valid JSON.');
  });

  it('returns 404 for an unknown movie id', async () => {
    const response = await fetch(`${baseUrl}/movies/991499999`);

    expect(response.status).toBe(404);

    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe('movie_not_found');
  });

  it('returns 413 for an oversized JSON body', async () => {
    const response = await fetch(`${baseUrl}/taste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'a'.repeat(300_000) }),
    });

    expect(response.status).toBe(413);

    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe('payload_too_large');
  });
});

describe('mounted API routes with a failing database', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(createApp({ db: {} as Database })));
  });

  afterAll(async () => {
    await close(server);
  });

  it('mounts /recommendations and validates its body', async () => {
    const response = await fetch(`${baseUrl}/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'catalog', limit: 5 }),
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 500 internal_error when a handler rejects', async () => {
    const response = await fetch(`${baseUrl}/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'catalog', limit: 1 }),
    });

    expect(response.status).toBe(500);

    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe('internal_error');
  });
});
