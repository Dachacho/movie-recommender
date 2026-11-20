export function* parseCsv(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? '';

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        inQuotes = false;
        index += 1;
        continue;
      }

      field += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (character === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (character === '\r') {
      index += 1;
      continue;
    }

    if (character === '\n') {
      row.push(field);
      field = '';
      yield row;
      row = [];
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

export function toObjects(header: string[], rows: Iterable<string[]>): Record<string, string>[] {
  const objects: Record<string, string>[] = [];

  for (const row of rows) {
    const object: Record<string, string> = {};

    header.forEach((column, index) => {
      object[column] = row[index] ?? '';
    });

    objects.push(object);
  }

  return objects;
}
