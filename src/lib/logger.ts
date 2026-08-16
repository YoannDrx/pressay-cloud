const forbiddenLogKeys = new Set([
  'api_key',
  'apikey',
  'audio',
  'authorization',
  'clipboard',
  'content',
  'cookie',
  'prompt',
  'selected',
  'text',
  'transcript',
]);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SafeLogValue = boolean | number | string | null | undefined;
export type SafeLogFields = Readonly<Record<string, SafeLogValue>>;

export function assertSafeLogFields(fields: SafeLogFields): void {
  for (const key of Object.keys(fields)) {
    if (forbiddenLogKeys.has(key.toLowerCase())) {
      throw new Error(`Forbidden log field: ${key}`);
    }
  }
}

export function writeLog(
  level: LogLevel,
  event: string,
  fields: SafeLogFields = {},
): void {
  assertSafeLogFields(fields);
  const entry = JSON.stringify({
    event,
    ...fields,
    level,
    timestamp: new Date().toISOString(),
  });

  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export const forbiddenLogFieldNames = Object.freeze([...forbiddenLogKeys]);
