import { z } from 'zod';

const DEFAULT_PORT = 3000;
const portSchema = z.coerce.number().int().min(1).max(65535);

export function parsePort(value: string | undefined): number {
  const result = portSchema.safeParse(value ?? DEFAULT_PORT);

  if (!result.success) {
    throw new Error(`Invalid PORT: ${String(value)}`);
  }

  return result.data;
}
