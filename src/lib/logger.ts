const forbiddenLogKeys = new Set([
  'account_id',
  'address',
  'api_key',
  'apikey',
  'audio',
  'authorization',
  'body',
  'clipboard',
  'content',
  'cookie',
  'credential',
  'customer_id',
  'device_id',
  'email',
  'password',
  'payload',
  'phone',
  'prompt',
  'raw',
  'response',
  'secret',
  'selected',
  'text',
  'token',
  'transcript',
  'transcription',
  'user_id',
]);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SafeLogValue = boolean | number | string | null | undefined;
export type SafeLogFields = Readonly<Record<string, SafeLogValue>>;

export function assertSafeLogFields(fields: SafeLogFields): void {
  for (const key of Object.keys(fields)) {
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase()
      .replace(/^_+|_+$/g, '');
    const tokens = normalizedKey.split('_');
    const containsForbiddenToken = tokens.some((token) => forbiddenLogKeys.has(token));
    const containsForbiddenCompound = [...forbiddenLogKeys].some(
      (forbidden) =>
        forbidden.includes('_') &&
        (normalizedKey.startsWith(`${forbidden}_`) ||
          normalizedKey.endsWith(`_${forbidden}`) ||
          normalizedKey.includes(`_${forbidden}_`)),
    );
    if (
      forbiddenLogKeys.has(normalizedKey) ||
      containsForbiddenToken ||
      containsForbiddenCompound
    ) {
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
