import { describe, expect, it } from 'vitest';
import { parsePort } from './env.js';

describe('parsePort', () => {
  it('defaults to 3000 when unset', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it('accepts a valid port', () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it.each(['0', '65536', 'abc', ''])('rejects %j', (value) => {
    expect(() => parsePort(value)).toThrow('Invalid PORT');
  });
});
