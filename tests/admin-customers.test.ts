import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: vi.fn() }) }));
import { classifySearch, likePattern } from '../src/services/admin-customers.ts';

describe('admin customer search', () => {
  it.each([
    ['', 'none'],
    ['   ', 'none'],
    ['cus_Q1w2E3', 'stripe_customer'],
    ['sub_1PqRsT', 'stripe_subscription'],
    ['2000000123456789', 'apple_transaction'],
    ['aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970', 'uuid'],
    [' AA72EF7F-A1A3-4CD9-AE1D-7CBF08A38970 ', 'uuid'],
    ['someone@example.test', 'text'],
    ['cus_', 'text'],
    ['cus_abc def', 'text'],
    ['1234', 'text'],
    ['sandbox/2000000123456789', 'text'],
  ])('classifies %j as %s', (input, kind) => {
    expect(classifySearch(input)).toBe(kind);
  });

  it('escapes LIKE wildcards and the escape character', () => {
    expect(likePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
    expect(likePattern('plain@example.test')).toBe('plain@example.test');
  });
});
