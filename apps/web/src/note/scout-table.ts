function cellCount(line: string): number {
  const cells = line.trim().split(/(?<!\\)(?:\\\\)*\|/);
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells.length;
}

// markdown-it pads/truncates uneven rows; check the source before rendering loses that evidence.
export function hasEvenScoutTableRows(lines: readonly string[], map: readonly [number, number]): boolean {
  const [start, end] = map;
  const width = cellCount(lines[start] ?? '');
  return width > 0 && !lines.slice(start + 2, end).some((line) => cellCount(line) !== width);
}

export function hasRegularScoutTableShape(headers: readonly string[], rows: readonly (readonly string[])[]): boolean {
  return headers.length > 0 && rows.length > 0 && headers.every((header) => header.trim()) &&
    rows.every((row) => row.length === headers.length);
}
