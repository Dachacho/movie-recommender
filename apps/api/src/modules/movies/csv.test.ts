import { describe, expect, it } from 'vitest';
import { MalformedCsvError, parseCsv, toObjects } from './csv.js';

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

  it('throws before yielding a record with an unterminated quoted field', () => {
    const rows = parseCsv('Date,Name\n2026-01-01,"Unclosed');

    expect(rows.next()).toEqual({ done: false, value: ['Date', 'Name'] });
    expect(() => rows.next()).toThrow(MalformedCsvError);
  });

  it('yields a well-formed final record without a trailing newline', () => {
    expect([...parseCsv('a,b\n1,2')]).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('yields a properly closed quoted field at the end of input', () => {
    expect([...parseCsv('a,b\n1,"x,y"')]).toEqual([
      ['a', 'b'],
      ['1', 'x,y'],
    ]);
  });
});

describe('toObjects', () => {
  it('maps rows by header', () => {
    const [header, ...rows] = [...parseCsv('id,title\n1,Toy Story\n')];

    expect(toObjects(header ?? [], rows)).toEqual([{ id: '1', title: 'Toy Story' }]);
  });
});
