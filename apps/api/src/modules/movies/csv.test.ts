import { describe, expect, it } from 'vitest';
import { parseCsv, toObjects } from './csv.js';

describe('parseCsv', () => {
  it('handles quoted commas, quotes and newlines', () => {
    const rows = [...parseCsv('a,b\n"x,1","line\nbreak"\n"say ""hi""",2\n')];

    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'line\nbreak'],
      ['say "hi"', '2'],
    ]);
  });

  it('ignores carriage returns', () => {
    expect([...parseCsv('a,b\r\n1,2\r\n')]).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps trailing empty fields', () => {
    expect([...parseCsv('a,b\n1,\n')]).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
});

describe('toObjects', () => {
  it('maps rows by header', () => {
    const [header, ...rows] = [...parseCsv('id,title\n1,Toy Story\n')];

    expect(toObjects(header ?? [], rows)).toEqual([{ id: '1', title: 'Toy Story' }]);
  });
});
