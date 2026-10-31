/**
 * A CSV field, always quoted. A value a spreadsheet would read as a formula
 * (leading `=`, `+`, `-`, `@`, tab or carriage return) is prefixed with an
 * apostrophe so it stays text (CSV/formula injection).
 */
export function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** RFC 4180 document: header line, one line per row, CRLF line endings. */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const lines = [header.join(','), ...rows.map((row) => row.map(csvField).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
