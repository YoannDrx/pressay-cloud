import { describe, expect, it } from 'vitest';

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { appleTransactionPrice } from '../src/services/apple-billing.ts';

describe('App Store prices for metrics', () => {
  it('converts Apple milliunits with the currency exponent', () => {
    expect(appleTransactionPrice({ price: 7990, currency: 'EUR' }, 'month')).toEqual({
      amountMinor: 799,
      currency: 'eur',
    });
    expect(
      appleTransactionPrice({ price: 1_200_000, currency: 'JPY' }, 'year'),
    ).toEqual({
      amountMinor: 1200,
      currency: 'jpy',
    });
    expect(appleTransactionPrice({ price: 2990, currency: 'KWD' }, 'month')).toEqual({
      amountMinor: 2990,
      currency: 'kwd',
    });
    expect(appleTransactionPrice({ price: 0, currency: 'EUR' }, 'month')).toEqual({
      amountMinor: 0,
      currency: 'eur',
    });
  });

  it('falls back to the configured App Store catalogue without a price', () => {
    process.env.DATABASE_URL = 'postgresql://example.test/test';
    process.env.PRESSAY_APP_STORE_ANNUAL_AMOUNT_MINOR = '6999';
    delete process.env.PRESSAY_APP_STORE_MONTHLY_AMOUNT_MINOR;
    clearEnvironmentCacheForTests();
    try {
      expect(appleTransactionPrice({}, 'year')).toEqual({
        amountMinor: 6999,
        currency: 'eur',
      });
      // Unset: the Stripe catalogue amount.
      expect(appleTransactionPrice({ price: 999 }, 'month')).toEqual({
        amountMinor: 799,
        currency: 'eur',
      });
    } finally {
      delete process.env.PRESSAY_APP_STORE_ANNUAL_AMOUNT_MINOR;
      clearEnvironmentCacheForTests();
    }
  });
});
