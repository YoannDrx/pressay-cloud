import { describe, expect, it, vi } from 'vitest';

import { assertSafeLogFields, writeLog } from '../src/lib/logger.ts';

describe('safe logger', () => {
  it.each(['text', 'audio', 'clipboard', 'prompt', 'api_key', 'authorization'])(
    'rejects the prohibited %s field',
    (field) => {
      expect(() => assertSafeLogFields({ [field]: 'secret' })).toThrow(
        `Forbidden log field: ${field}`,
      );
    },
  );

  it.each([
    'transcription_text',
    'requestBody',
    'stripe_customer_id',
    'device-id',
    'accessToken',
    'provider_payload',
  ])('rejects the sensitive composite %s field', (field) => {
    expect(() => assertSafeLogFields({ [field]: 'redacted' })).toThrow(
      `Forbidden log field: ${field}`,
    );
  });

  it('emits metadata without user content', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeLog('info', 'operation.completed', { duration_ms: 12, status: 200 });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain('operation.completed');
    spy.mockRestore();
  });
});
